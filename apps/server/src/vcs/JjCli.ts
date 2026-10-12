/**
 * Runs jj for T3. Every call names the workspace root with `-R` and spawns
 * from the server's cwd, so an isolated project's environment never routes it.
 * Output settings from the user's config are pinned off.
 *
 * jj has no stable API; templates are the contract. Callers always pass
 * explicit `-T` templates and parse stdout only, because jj writes warnings
 * and progress to stderr.
 *
 * @module JjCli
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import { type VcsError, VcsProcessExitError } from "@t3tools/contracts";
import * as VcsProcess from "./VcsProcess.ts";

/** Colocated workspaces, `jj util snapshot` and `json()` templates all need this. */
const MINIMUM_JJ_VERSION = [0, 46] as const;

export interface JjRunInput {
  readonly operation: string;
  /** Workspace root, passed as `-R`. */
  readonly root: string;
  /** For commands that create a repository, which `-R` would reject. */
  readonly withoutRepository?: boolean;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: string;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface JjGitInput {
  readonly operation: string;
  readonly root: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly allowNonZeroExit?: boolean;
  readonly maxOutputBytes?: number;
  readonly outputMode?: VcsProcess.VcsProcessInput["outputMode"];
}

export class JjCli extends Context.Service<
  JjCli,
  {
    /** The installed jj version, or null when jj is missing. */
    readonly version: Effect.Effect<readonly [number, number, number] | null>;
    /** Whether jj is installed and new enough for T3's jj support. */
    readonly supported: Effect.Effect<boolean>;
    /**
     * Runs jj and fails on a non-zero exit unless allowed. Commands that
     * snapshot are retried when another process holds the working copy, and a
     * stale workspace is updated once before retrying.
     */
    readonly run: (input: JjRunInput) => Effect.Effect<VcsProcess.VcsProcessOutput, VcsError>;
    /** Runs a jj command and returns its trimmed stdout. */
    readonly read: (input: JjRunInput) => Effect.Effect<string, VcsError>;
    /**
     * Runs git against the repository's backing Git store. jj writes every
     * commit there, so Git's diff output works for any jj commit, including
     * hidden ones, without a Git worktree.
     */
    readonly git: (input: JjGitInput) => Effect.Effect<VcsProcess.VcsProcessOutput, VcsError>;
    /** The shared repository directory (`.jj/repo`, following a workspace's pointer file). */
    readonly repositoryDirectory: (root: string) => Effect.Effect<string, VcsError>;
    /**
     * Serializes T3's mutations of one working copy: seals, reverts and actions.
     * Agents' own jj commands still run concurrently; jj merges those.
     */
    readonly withWorkingCopyLock: <A, E, R>(
      root: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("t3/vcs/JjCli") {}

// A user's `ui.log-word-wrap` would break template lines, JSON fields included.
export const STABLE_OUTPUT_ARGS = [
  "--no-pager",
  "--color=never",
  "--config",
  "ui.log-word-wrap=false",
] as const;

const VERSION_RETRY_MILLIS = 30_000;
const CONCURRENT_WORKING_COPY = /concurrent working copy operation/i;
const STALE_WORKING_COPY = /working copy is stale/i;

function parseJjVersion(stdout: string): readonly [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isSupportedJjVersion(version: readonly [number, number, number] | null): boolean {
  if (version === null) return false;
  const [major, minor] = version;
  return (
    major > MINIMUM_JJ_VERSION[0] ||
    (major === MINIMUM_JJ_VERSION[0] && minor >= MINIMUM_JJ_VERSION[1])
  );
}

const make = Effect.gen(function* () {
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const raw = (input: JjRunInput) =>
    vcsProcess.run({
      operation: input.operation,
      command: "jj",
      args: [
        ...STABLE_OUTPUT_ARGS,
        ...(input.withoutRepository === true ? [] : ["-R", input.root]),
        ...input.args,
      ],
      cwd: input.root,
      spawnCwd: globalThis.process.cwd(),
      allowNonZeroExit: true,
      timeoutMs: input.timeoutMs ?? 60_000,
      ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
      ...(input.env === undefined ? {} : { env: input.env }),
      ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
    });

  const probeVersion = vcsProcess
    .run({
      operation: "JjCli.version",
      command: "jj",
      args: ["--version"],
      cwd: globalThis.process.cwd(),
      allowNonZeroExit: true,
      timeoutMs: 10_000,
    })
    .pipe(
      Effect.map((result) => (result.exitCode === 0 ? parseJjVersion(result.stdout) : null)),
      Effect.orElseSucceed(() => null),
    );
  // A found version is kept; a failed probe, such as a timeout under load, is retried later.
  const probed = yield* Ref.make<{
    readonly version: readonly [number, number, number] | null;
    readonly at: number;
  } | null>(null);
  const version = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const last = yield* Ref.get(probed);
    if (last !== null && (last.version !== null || now - last.at < VERSION_RETRY_MILLIS)) {
      return last.version;
    }
    const found = yield* probeVersion;
    yield* Ref.set(probed, { version: found, at: now });
    return found;
  });

  class RetryableJjError {
    readonly _tag = "RetryableJjError";
  }

  const commitsOf = (input: JjRunInput, revset: string) =>
    raw({
      ...input,
      operation: `${input.operation}.updateStale.read`,
      args: [
        "--ignore-working-copy",
        "log",
        "--no-graph",
        "-r",
        revset,
        "-T",
        'commit_id ++ "\\n"',
      ],
    }).pipe(
      Effect.map((result) =>
        result.exitCode === 0 ? result.stdout.split("\n").filter((line) => line.length > 0) : [],
      ),
    );

  /**
   * Another workspace rewrote this one's `@` or an ancestor. `update-stale`
   * snapshots the files on disk into a divergent copy of `@` and checks out
   * the rewritten `@` without the edits made since the last snapshot. jj
   * rebases the copy beside `@`, so its tree is the up-to-date one: `@` takes
   * it and the copy goes. A copy left on other parents is squashed instead.
   */
  const updateStale = (input: JjRunInput) =>
    Effect.gen(function* () {
      const [changeId] = (yield* raw({
        ...input,
        operation: `${input.operation}.updateStale.read`,
        args: ["--ignore-working-copy", "log", "--no-graph", "-r", "@", "-T", "change_id"],
      })).stdout.split("\n");
      const versions = changeId ? `change_id(${changeId.trim()})` : null;
      const before = new Set(versions === null ? [] : yield* commitsOf(input, versions));
      yield* raw({
        ...input,
        operation: `${input.operation}.updateStale`,
        args: ["workspace", "update-stale"],
      });
      if (versions === null) return;
      const parentsOf = (revision: string) =>
        raw({
          ...input,
          operation: `${input.operation}.updateStale.read`,
          args: [
            "--ignore-working-copy",
            "log",
            "--no-graph",
            "-r",
            revision,
            "-T",
            'parents.map(|c| c.commit_id()).join(",")',
          ],
        }).pipe(Effect.map((result) => result.stdout.trim()));
      for (const commit of yield* commitsOf(input, `${versions} ~ @`)) {
        if (before.has(commit)) continue;
        const recover = (args: ReadonlyArray<string>) =>
          raw({ ...input, operation: `${input.operation}.updateStale.recover`, args });
        if ((yield* parentsOf(commit)) === (yield* parentsOf("@"))) {
          yield* recover(["restore", "--from", commit, "--into", "@"]);
          yield* recover(["abandon", commit]);
        } else {
          yield* recover(["squash", "--from", commit, "--into", "@", "--use-destination-message"]);
        }
      }
    });

  const run: JjCli["Service"]["run"] = Effect.fn("JjCli.run")(function* (input) {
    let updatedStale = false;
    const attempt = Effect.gen(function* () {
      const result = yield* raw(input);
      if (result.exitCode === 0) return result;
      if (CONCURRENT_WORKING_COPY.test(result.stderr))
        return yield* Effect.fail(new RetryableJjError());
      if (STALE_WORKING_COPY.test(result.stderr) && !updatedStale) {
        updatedStale = true;
        yield* updateStale(input);
        return yield* Effect.fail(new RetryableJjError());
      }
      if (input.allowNonZeroExit) return result;
      return yield* new VcsProcessExitError({
        operation: input.operation,
        command: "jj",
        cwd: input.root,
        exitCode: result.exitCode,
        detail: result.stderr.trim().split("\n").at(-1) || "jj exited with a non-zero status.",
      });
    });
    return yield* attempt.pipe(
      Effect.retry({
        times: 4,
        while: (error) => error._tag === "RetryableJjError",
        schedule: Schedule.exponential(Duration.millis(100)),
      }),
      Effect.catchTag("RetryableJjError", () =>
        Effect.fail(
          new VcsProcessExitError({
            operation: input.operation,
            command: "jj",
            cwd: input.root,
            exitCode: 1,
            detail: "Another jj command kept the working copy busy.",
          }),
        ),
      ),
    );
  });

  const read: JjCli["Service"]["read"] = (input) =>
    run(input).pipe(Effect.map((result) => result.stdout.trim()));

  const repositoryDirectory: JjCli["Service"]["repositoryDirectory"] = Effect.fn(
    "JjCli.repositoryDirectory",
  )(function* (root) {
    const metadata = path.join(root, ".jj");
    const pointer = path.join(metadata, "repo");
    const info = yield* fileSystem.stat(pointer).pipe(Effect.orElseSucceed(() => null));
    if (info === null) {
      return yield* new VcsProcessExitError({
        operation: "JjCli.repositoryDirectory",
        command: "jj",
        cwd: root,
        exitCode: 1,
        detail: "No jj repository metadata was found.",
      });
    }
    if (info.type === "Directory") return pointer;
    const target = (yield* fileSystem
      .readFileString(pointer)
      .pipe(Effect.orElseSucceed(() => ""))).trim();
    return path.resolve(metadata, target);
  });

  const gitStore = Effect.fn("JjCli.gitStore")(function* (root: string) {
    const repository = yield* repositoryDirectory(root);
    const store = path.join(repository, "store");
    const target = (yield* fileSystem
      .readFileString(path.join(store, "git_target"))
      .pipe(Effect.orElseSucceed(() => ""))).trim();
    if (target.length === 0) {
      return yield* new VcsProcessExitError({
        operation: "JjCli.gitStore",
        command: "jj",
        cwd: root,
        exitCode: 1,
        detail: "This jj repository has no Git backend.",
      });
    }
    return path.resolve(store, target);
  });

  const git: JjCli["Service"]["git"] = Effect.fn("JjCli.git")(function* (input) {
    const store = yield* gitStore(input.root);
    return yield* vcsProcess.run({
      operation: input.operation,
      command: "git",
      args: ["--git-dir", store, ...input.args],
      cwd: input.root,
      spawnCwd: globalThis.process.cwd(),
      ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
      ...(input.allowNonZeroExit === undefined ? {} : { allowNonZeroExit: input.allowNonZeroExit }),
      ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
      ...(input.outputMode === undefined ? {} : { outputMode: input.outputMode }),
    });
  });

  const locks = yield* Ref.make(new Map<string, Semaphore.Semaphore>());
  const lockFor = (root: string) =>
    Effect.gen(function* () {
      const existing = (yield* Ref.get(locks)).get(root);
      if (existing !== undefined) return existing;
      const created = yield* Semaphore.make(1);
      return yield* Ref.modify(locks, (current) => {
        const concurrent = current.get(root);
        if (concurrent !== undefined) return [concurrent, current];
        const next = new Map(current);
        next.set(root, created);
        return [created, next];
      });
    });
  const withWorkingCopyLock: JjCli["Service"]["withWorkingCopyLock"] = (root, effect) =>
    Effect.flatMap(lockFor(root), (semaphore) => semaphore.withPermits(1)(effect));

  return JjCli.of({
    withWorkingCopyLock,
    version,
    supported: Effect.map(version, isSupportedJjVersion),
    run,
    read,
    git,
    repositoryDirectory,
  });
});

export const layer = Layer.effect(JjCli, make);
