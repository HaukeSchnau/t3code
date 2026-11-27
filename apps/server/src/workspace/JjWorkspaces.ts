// @effect-diagnostics nodeBuiltinImport:off -- realpath and marker lookups are synchronous filesystem probes.
/**
 * jj workspaces as managed workspaces. `jj workspace add` shares the repository store, so changes
 * are visible across workspaces without pushing. In a colocated repository jj also creates the
 * Git worktree; T3 never runs `git worktree` itself for jj repositories.
 */
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import { STABLE_OUTPUT_ARGS } from "../vcs/JjCli.ts";
import { findRepositoryMarker, realpathOrResolve as realpath } from "../vcs/RepositoryMarker.ts";
import {
  ManagedWorkspaceError,
  removeWorkspaceDirectory,
  runWorkspaceCommand,
  runWorkspaceCommandOrFail,
} from "./WorkspaceCommand.ts";

const jj = (operation: string, repository: string, args: ReadonlyArray<string>) =>
  runWorkspaceCommandOrFail({
    operation,
    command: "jj",
    args: [...STABLE_OUTPUT_ARGS, "-R", repository, ...args],
    timeout: "3 minutes",
  });

interface JjWorkspaceEntry {
  readonly name: string;
  readonly root: string | null;
}

export const listJjWorkspaces = Effect.fn("JjWorkspaces.list")(function* (repository: string) {
  const output = yield* jj("JjWorkspaces.list", repository, [
    "--ignore-working-copy",
    "workspace",
    "list",
    "-T",
    'name ++ "\\t" ++ root ++ "\\n"',
  ]);
  return output
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line): JjWorkspaceEntry => {
      const [name = "", root = ""] = line.split("\t");
      return { name: name.trim(), root: root.trim() || null };
    });
});

/** Resolves a user revision to a revset that names exactly one commit, or undefined. */
const resolveRevision = Effect.fn("JjWorkspaces.resolveRevision")(function* (
  repository: string,
  candidates: ReadonlyArray<string>,
) {
  for (const candidate of candidates) {
    const result = yield* runWorkspaceCommand({
      operation: "JjWorkspaces.resolveRevision",
      command: "jj",
      args: [
        "--no-pager",
        "-R",
        repository,
        "--ignore-working-copy",
        "log",
        "--no-graph",
        "-r",
        candidate,
        "-T",
        'commit_id ++ "\\n"',
      ],
    });
    const commits = result.stdout.split("\n").filter((line) => line.trim().length > 0);
    if (result.code === 0 && commits.length === 1) return candidate;
  }
  return undefined;
});

/** A jj string literal, so branch names with `/` or `-` are not parsed as revset operators. */
const revsetString = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const revisionCandidates = (ref: string) => [revsetString(ref), ref];

/** The revset a new workspace starts from; undefined keeps jj's default parents. */
export const resolveJjStartRevision = Effect.fn("JjWorkspaces.startRevision")(function* (input: {
  readonly repository: string;
  readonly baseRef: string | undefined;
  readonly startFromOrigin: boolean;
}) {
  if (input.baseRef === undefined) return undefined;
  if (input.startFromOrigin) {
    const remotes = yield* jj("JjWorkspaces.remotes", input.repository, ["git", "remote", "list"]);
    if (remotes.split("\n").some((line) => line.split(/\s+/)[0] === "origin")) {
      yield* jj("JjWorkspaces.fetch", input.repository, [
        "git",
        "fetch",
        "--remote",
        "origin",
        "--branch",
        input.baseRef,
      ]);
      const remote = yield* resolveRevision(input.repository, [
        `${revsetString(input.baseRef)}@origin`,
      ]);
      if (remote !== undefined) return remote;
    }
  }
  return yield* resolveRevision(input.repository, revisionCandidates(input.baseRef));
});

/**
 * Adds a workspace for the project's repository at `destination`. A project in
 * a subdirectory of its repository keeps working in the same subdirectory.
 * Returns the path the thread should use.
 */
export const createJjWorkspace = Effect.fn("JjWorkspaces.create")(function* (input: {
  readonly projectRoot: string;
  readonly destination: string;
  readonly name: string;
  readonly description: string;
  readonly baseRef?: string | undefined;
  readonly startFromOrigin?: boolean | undefined;
  /** Commit ids to start from, in place of `baseRef`. */
  readonly revisions?: ReadonlyArray<string> | undefined;
}) {
  const marker = findRepositoryMarker(input.projectRoot);
  if (marker?.kind !== "jj") {
    return yield* new ManagedWorkspaceError({
      operation: "JjWorkspaces.create",
      detail: `'${input.projectRoot}' is not inside a jj repository.`,
    });
  }
  const repository = marker.root;
  const relative = NodePath.relative(repository, realpath(input.projectRoot));
  const revisions =
    input.revisions ??
    (yield* resolveJjStartRevision({
      repository,
      baseRef: input.baseRef,
      startFromOrigin: input.startFromOrigin === true,
    }).pipe(Effect.map((revision) => (revision === undefined ? [] : [revision]))));
  yield* jj("JjWorkspaces.add", repository, [
    "workspace",
    "add",
    // A colocated repository gets colocated workspaces, so Git tooling and
    // T3's Git-backed features work in them too.
    ...(marker.colocated ? ["--colocate"] : []),
    "--name",
    input.name,
    "--message",
    input.description,
    ...revisions.flatMap((revision) => ["--revision", revision]),
    input.destination,
  ]).pipe(
    Effect.tapError(() =>
      runWorkspaceCommand({
        operation: "JjWorkspaces.cleanup",
        command: "jj",
        args: ["-R", repository, "--ignore-working-copy", "workspace", "forget", input.name],
      }).pipe(Effect.andThen(removeWorkspaceDirectory(input.destination)), Effect.ignore),
    ),
  );
  return relative === "" ? input.destination : NodePath.join(input.destination, relative);
});

/** The jj name of the workspace rooted at `workspaceRoot`. */
export const jjWorkspaceName = Effect.fn("JjWorkspaces.name")(function* (workspaceRoot: string) {
  const root = realpath(workspaceRoot);
  const workspaces = yield* listJjWorkspaces(root).pipe(
    Effect.orElseSucceed((): ReadonlyArray<JjWorkspaceEntry> => []),
  );
  return (
    workspaces.find((entry) => entry.root !== null && realpath(entry.root) === root)?.name ??
    NodePath.basename(root)
  );
});

/** Forgets the jj workspace rooted at `workspaceRoot`, then removes its files. */
export const deleteJjWorkspace = Effect.fn("JjWorkspaces.delete")(function* (
  workspaceRoot: string,
) {
  const root = realpath(workspaceRoot);
  const name = yield* jjWorkspaceName(root);
  if (name === "default") {
    return yield* new ManagedWorkspaceError({
      operation: "JjWorkspaces.delete",
      detail: "The repository's default jj workspace cannot be deleted.",
    });
  }
  yield* runWorkspaceCommand({
    operation: "JjWorkspaces.forget",
    command: "jj",
    args: ["-R", root, "--ignore-working-copy", "workspace", "forget", name],
  });
  yield* removeWorkspaceDirectory(root);
});

export interface JjWorkspaceInspection {
  /** Why removing the workspace could lose work no remote has, or null. */
  readonly keep: string | null;
  /** Whether `@` adds no change beyond `trunk()`. */
  readonly unchanged: boolean;
  /** Commit ids a recreated workspace starts from: `@`, or its parents while `@` is empty. */
  readonly revisions: ReadonlyArray<string>;
}

// Local bookmarks and tags don't count: an agent-exec fork's own store goes with its folder.
const ON_A_REMOTE = "::(remote_bookmarks() | remote_tags())";

/**
 * Snapshots the workspace at `root`, then reads what removing it would lose. A workspace of a
 * shared store leaves its commits in that store, so only the history of its `@` counts; an
 * agent-exec fork (`ownStore`) takes every commit of its repository with it.
 */
export const inspectJjWorkspace = Effect.fn("JjWorkspaces.inspect")(function* (input: {
  readonly root: string;
  readonly ownStore: boolean;
}) {
  const keep = (reason: string): JjWorkspaceInspection => ({
    keep: reason,
    unchanged: false,
    revisions: [],
  });
  // A plain status snapshots the working copy, so files nobody committed become part of `@`.
  const status = yield* runWorkspaceCommand({
    operation: "JjWorkspaces.inspect",
    command: "jj",
    args: [...STABLE_OUTPUT_ARGS, "-R", input.root, "status"],
    timeout: "5 minutes",
  });
  if (status.code !== 0) {
    const detail = status.stderr.trim().split(/\r?\n/)[0] || `exit ${status.code ?? "unknown"}`;
    return keep(`jj could not snapshot the working copy (${detail})`);
  }
  // jj leaves files over `snapshot.max-new-file-size`, or outside `snapshot.auto-track`, out of `@`.
  if (/^Untracked paths:$/m.test(status.stdout) || status.stderr.includes("Refused to snapshot")) {
    return keep("has files jj did not snapshot");
  }
  const read = (revset: string, template: string) =>
    jj("JjWorkspaces.inspect", input.root, [
      "--ignore-working-copy",
      "log",
      "--no-graph",
      "--limit",
      "1",
      "-r",
      revset,
      "-T",
      template,
    ]);
  const unpushed = yield* read(
    `(${input.ownStore ? "all()" : "::@"} ~ ${ON_A_REMOTE}) ~ empty()`,
    "change_id.short()",
  );
  if (unpushed !== "") return keep(`change ${unpushed} is not on a remote bookmark or tag`);
  const beyondTrunk = yield* read("(trunk()..@) ~ empty()", "change_id.short()");
  const revisions = yield* read(
    "@",
    'if(empty, parents.map(|parent| parent.commit_id()).join(" "), commit_id)',
  );
  return {
    keep: null,
    unchanged: beyondTrunk === "",
    revisions: revisions.split(" ").filter((revision) => revision !== ""),
  } satisfies JjWorkspaceInspection;
});
