/**
 * The jj VCS driver. Checkpoints are commit ids of `@` taken after a snapshot:
 * every snapshot is already a commit, and older versions of `@` stay
 * addressable after jj rewrites it. T3 records which commit a checkpoint ref
 * names in `.jj/t3/checkpoints`, so jj's history carries no T3 objects.
 *
 * @module JjVcsDriver
 */
import * as NodeCrypto from "node:crypto";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { type CheckpointRef, VcsProcessExitError } from "@t3tools/contracts";
import { PATCH_RENDER_PREFIX_ARGS } from "./GitVcsDriverCore.ts";
import * as JjCli from "./JjCli.ts";
import { findRepositoryMarker } from "./RepositoryMarker.ts";
import type * as VcsDriver from "./VcsDriver.ts";

const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;
const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** A jj string literal for revsets, filesets and templates. */
export const jjString = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;

/** An exact workspace-relative fileset for each path. */
export const jjFilesets = (paths: ReadonlyArray<string>) =>
  paths.map((path) => `root-file:${jjString(path)}`);

export const splitNul = (stdout: string) => stdout.split("\0").filter((entry) => entry.length > 0);

const checkpointFilePath = (path: Path.Path, root: string, checkpointRef: CheckpointRef) =>
  path.join(
    root,
    ".jj",
    "t3",
    "checkpoints",
    NodeCrypto.createHash("sha256").update(checkpointRef).digest("hex").slice(0, 32),
  );

const nowFreshness = () =>
  DateTime.now.pipe(
    Effect.map((observedAt) => ({
      source: "live-local" as const,
      observedAt,
      expiresAt: Option.none(),
    })),
  );

/** Snapshots the working copy and returns the commit id of `@`. */
export const snapshotWorkingCopy = (jj: JjCli.JjCli["Service"], root: string, operation: string) =>
  jj.read({ operation, root, args: ["log", "--no-graph", "-r", "@", "-T", "commit_id"] });

export const makeVcsDriverShape = Effect.fn("makeJjVcsDriverShape")(function* () {
  const jj = yield* JjCli.JjCli;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const rootFor = (cwd: string) => findRepositoryMarker(cwd);

  const requireRoot = (operation: string, cwd: string) => {
    const marker = rootFor(cwd);
    return marker?.kind === "jj"
      ? Effect.succeed(marker)
      : Effect.fail(
          new VcsProcessExitError({
            operation,
            command: "jj",
            cwd,
            exitCode: 1,
            detail: "Not inside a jj repository.",
          }),
        );
  };

  const capabilities = {
    kind: "jj" as const,
    supportsWorktrees: true,
    supportsBookmarks: true,
    supportsAtomicSnapshot: true,
    supportsPushDefaultRemote: true,
    ignoreClassifier: "native" as const,
  };

  const execute: VcsDriver.VcsDriver["Service"]["execute"] = (input) =>
    Effect.gen(function* () {
      const marker = yield* requireRoot(input.operation, input.cwd);
      return yield* jj.run({
        operation: input.operation,
        root: marker.root,
        args: input.args,
        ...(input.env === undefined ? {} : { env: input.env }),
        ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
        ...(input.allowNonZeroExit === undefined
          ? {}
          : { allowNonZeroExit: input.allowNonZeroExit }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
      });
    });

  const detectRepository: VcsDriver.VcsDriver["Service"]["detectRepository"] = Effect.fn(
    "JjVcsDriver.detectRepository",
  )(function* (cwd) {
    const marker = rootFor(cwd);
    if (marker?.kind !== "jj" || !(yield* jj.supported)) return null;
    return {
      kind: "jj" as const,
      rootPath: marker.root,
      metadataPath: path.join(marker.root, ".jj"),
      freshness: yield* nowFreshness(),
    };
  });

  const isInsideWorkTree: VcsDriver.VcsDriver["Service"]["isInsideWorkTree"] = (cwd) =>
    detectRepository(cwd).pipe(Effect.map((repository) => repository !== null));

  const listWorkspaceFiles: VcsDriver.VcsDriver["Service"]["listWorkspaceFiles"] = Effect.fn(
    "JjVcsDriver.listWorkspaceFiles",
  )(function* (cwd) {
    const marker = yield* requireRoot("JjVcsDriver.listWorkspaceFiles", cwd);
    const result = yield* jj.run({
      operation: "JjVcsDriver.listWorkspaceFiles",
      root: marker.root,
      args: ["file", "list", "-T", 'path ++ "\\0"'],
      maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
      timeoutMs: 20_000,
    });
    return {
      paths: splitNul(result.stdout),
      truncated: result.stdoutTruncated,
      freshness: yield* nowFreshness(),
    };
  });

  const listRemotes: VcsDriver.VcsDriver["Service"]["listRemotes"] = Effect.fn(
    "JjVcsDriver.listRemotes",
  )(function* (cwd) {
    const marker = yield* requireRoot("JjVcsDriver.listRemotes", cwd);
    const output = yield* jj.read({
      operation: "JjVcsDriver.listRemotes",
      root: marker.root,
      args: ["--ignore-working-copy", "git", "remote", "list"],
      timeoutMs: 10_000,
    });
    const remotes = output
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter(([name, url]) => name !== undefined && url !== undefined && name.length > 0)
      .map(([name, url]) => ({
        name: name!,
        url: url!,
        pushUrl: Option.none<string>(),
        isPrimary: name === "origin",
      }));
    return { remotes, freshness: yield* nowFreshness() };
  });

  // jj has no ignore query, but it follows .gitignore files, so Git answers
  // from the repository's backing store with the workspace as work tree.
  const filterIgnoredPaths: VcsDriver.VcsDriver["Service"]["filterIgnoredPaths"] = Effect.fn(
    "JjVcsDriver.filterIgnoredPaths",
  )(function* (cwd, relativePaths) {
    const marker = yield* requireRoot("JjVcsDriver.filterIgnoredPaths", cwd);
    if (relativePaths.length === 0) return relativePaths;
    const result = yield* jj.git({
      operation: "JjVcsDriver.filterIgnoredPaths",
      root: marker.root,
      args: ["--work-tree", marker.root, "check-ignore", "--no-index", "-z", "--stdin"],
      stdin: `${relativePaths.join("\0")}\0`,
      allowNonZeroExit: true,
    });
    const ignored = new Set(splitNul(result.stdout));
    return relativePaths.filter((relativePath) => !ignored.has(relativePath));
  });

  const initRepository: VcsDriver.VcsDriver["Service"]["initRepository"] = (input) =>
    jj
      .run({
        operation: "JjVcsDriver.initRepository",
        root: input.cwd,
        withoutRepository: true,
        args: ["git", "init", input.cwd],
        timeoutMs: 30_000,
      })
      .pipe(Effect.asVoid);

  const checkpointFile = (root: string, checkpointRef: CheckpointRef) =>
    checkpointFilePath(path, root, checkpointRef);

  /** The commit a checkpoint ref names, if it was recorded and jj still has it. */
  const resolveCheckpoint = Effect.fn("JjVcsDriver.resolveCheckpoint")(function* (
    root: string,
    checkpointRef: CheckpointRef,
  ) {
    const recorded = (yield* fileSystem
      .readFileString(checkpointFile(root, checkpointRef))
      .pipe(Effect.orElseSucceed(() => ""))).trim();
    if (!/^[0-9a-f]{40}$/.test(recorded)) {
      // A colocated repository checkpointed before jj support has Git refs,
      // which Git diffs can still read. jj never indexed those commits.
      const legacy = yield* jj
        .git({
          operation: "JjVcsDriver.resolveCheckpoint.git",
          root,
          args: ["rev-parse", "--verify", "--quiet", `${checkpointRef}^{commit}`],
          allowNonZeroExit: true,
        })
        .pipe(Effect.orElseSucceed(() => null));
      const commit = legacy?.exitCode === 0 ? legacy.stdout.trim() : "";
      return commit.length > 0 ? commit : null;
    }
    const exists = yield* jj.run({
      operation: "JjVcsDriver.resolveCheckpoint",
      root,
      args: ["--ignore-working-copy", "log", "--no-graph", "-r", recorded, "-T", "commit_id"],
      allowNonZeroExit: true,
      timeoutMs: 10_000,
    });
    return exists.exitCode === 0 ? recorded : null;
  });

  const resolveParentOfWorkingCopy = (root: string) =>
    jj
      .read({
        operation: "JjVcsDriver.resolveParent",
        root,
        args: [
          "--ignore-working-copy",
          "log",
          "--no-graph",
          "-r",
          "@-",
          "-T",
          'commit_id ++ "\\n"',
        ],
      })
      .pipe(Effect.map((output) => output.split("\n")[0]?.trim() || null));

  const checkpoints: VcsDriver.VcsCheckpointOps = {
    captureCheckpoint: Effect.fn("JjVcsDriver.checkpoints.captureCheckpoint")(function* (input) {
      const marker = yield* requireRoot("JjVcsDriver.checkpoints.captureCheckpoint", input.cwd);
      const commit = yield* snapshotWorkingCopy(
        jj,
        marker.root,
        "JjVcsDriver.checkpoints.captureCheckpoint",
      );
      const file = checkpointFile(marker.root, input.checkpointRef);
      const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
      yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true }).pipe(
        Effect.andThen(fileSystem.writeFileString(temporary, `${commit}\n`)),
        Effect.andThen(fileSystem.rename(temporary, file)),
        Effect.mapError(
          (cause) =>
            new VcsProcessExitError({
              operation: "JjVcsDriver.checkpoints.captureCheckpoint",
              command: "jj",
              cwd: input.cwd,
              exitCode: 1,
              detail: `Could not record the checkpoint: ${cause.message}`,
            }),
        ),
      );
    }),

    hasCheckpointRef: Effect.fn("JjVcsDriver.checkpoints.hasCheckpointRef")(function* (input) {
      const marker = yield* requireRoot("JjVcsDriver.checkpoints.hasCheckpointRef", input.cwd);
      return (yield* resolveCheckpoint(marker.root, input.checkpointRef)) !== null;
    }),

    restoreCheckpoint: Effect.fn("JjVcsDriver.checkpoints.restoreCheckpoint")(function* (input) {
      const marker = yield* requireRoot("JjVcsDriver.checkpoints.restoreCheckpoint", input.cwd);
      let commit = yield* resolveCheckpoint(marker.root, input.checkpointRef);
      if (commit === null && input.fallbackToHead === true) {
        commit = yield* resolveParentOfWorkingCopy(marker.root);
      }
      if (commit === null) return false;
      yield* jj.run({
        operation: "JjVcsDriver.checkpoints.restoreCheckpoint",
        root: marker.root,
        args: ["restore", "--from", commit],
      });
      return true;
    }),

    diffCheckpoints: Effect.fn("JjVcsDriver.checkpoints.diffCheckpoints")(function* (input) {
      const operation = "JjVcsDriver.checkpoints.diffCheckpoints";
      const marker = yield* requireRoot(operation, input.cwd);
      let from = yield* resolveCheckpoint(marker.root, input.fromCheckpointRef);
      if (from === null && input.fallbackFromToHead === true) {
        from = yield* resolveParentOfWorkingCopy(marker.root);
      }
      const to = yield* resolveCheckpoint(marker.root, input.toCheckpointRef);
      if (from === null || to === null) {
        return yield* new VcsProcessExitError({
          operation,
          command: "jj",
          cwd: input.cwd,
          exitCode: 1,
          detail: "Checkpoint is unavailable for diff operation.",
        });
      }
      const result = yield* jj.git({
        operation,
        root: marker.root,
        args: [
          "diff",
          ...(input.format === "numstat" ? ["--numstat", "-z"] : ["--patch"]),
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          ...PATCH_RENDER_PREFIX_ARGS,
          ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
          from,
          to,
        ],
        maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
        outputMode: input.format === "numstat" ? "error" : "truncate",
      });
      return result.stdout;
    }),

    // Later checkpoints stay recorded after a rollback, so undoing it can still
    // reach them. Ordinals are never reused, so nothing overwrites them.
    deleteCheckpointRefs: () => Effect.void,
  };

  return {
    capabilities,
    execute,
    checkpoints,
    detectRepository,
    isInsideWorkTree,
    listWorkspaceFiles,
    listRemotes,
    filterIgnoredPaths,
    initRepository,
  };
});

/** Resolves the commit a jj checkpoint ref recorded, for services that work below the driver. */
export const readCheckpointCommit = Effect.fn("JjVcsDriver.readCheckpointCommit")(function* (
  io: { readonly fileSystem: FileSystem.FileSystem; readonly path: Path.Path },
  root: string,
  checkpointRef: CheckpointRef,
) {
  const recorded = (yield* io.fileSystem
    .readFileString(checkpointFilePath(io.path, root, checkpointRef))
    .pipe(Effect.orElseSucceed(() => ""))).trim();
  return /^[0-9a-f]{40}$/.test(recorded) ? recorded : null;
});
