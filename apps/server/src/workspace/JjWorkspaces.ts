// @effect-diagnostics nodeBuiltinImport:off -- realpath and marker lookups are synchronous filesystem probes.
/**
 * jj workspaces as managed workspaces. A new workspace shares the project's
 * repository store (`jj workspace add`), so changes are visible from every
 * workspace without pushing. Git worktrees are never used for jj repositories.
 *
 * @module JjWorkspaces
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import {
  ManagedWorkspaceError,
  removeWorkspaceDirectory,
  runWorkspaceCommand,
  runWorkspaceCommandOrFail,
} from "./WorkspaceCommand.ts";

function realpath(path: string): string {
  try {
    return NodeFS.realpathSync.native(path);
  } catch {
    return NodePath.resolve(path);
  }
}

interface RepositoryMarker {
  readonly kind: "jj" | "git";
  readonly root: string;
}

/**
 * The nearest repository boundary at or above `path`. A colocated repository
 * (`.jj` next to `.git`) is a jj repository.
 */
export function findRepositoryMarker(path: string): RepositoryMarker | null {
  let current = realpath(path);
  while (true) {
    if (NodeFS.statSync(NodePath.join(current, ".jj"), { throwIfNoEntry: false })?.isDirectory()) {
      return { kind: "jj", root: current };
    }
    if (NodeFS.existsSync(NodePath.join(current, ".git"))) return { kind: "git", root: current };
    const parent = NodePath.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

const jj = (operation: string, repository: string, args: ReadonlyArray<string>) =>
  runWorkspaceCommandOrFail({
    operation,
    command: "jj",
    args: ["--no-pager", "--color=never", "-R", repository, ...args],
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
  const revision = yield* resolveJjStartRevision({
    repository,
    baseRef: input.baseRef,
    startFromOrigin: input.startFromOrigin === true,
  });
  yield* jj("JjWorkspaces.add", repository, [
    "workspace",
    "add",
    "--name",
    input.name,
    "--message",
    input.description,
    ...(revision === undefined ? [] : ["--revision", revision]),
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

/** Forgets the jj workspace rooted at `workspaceRoot`, then removes its files. */
export const deleteJjWorkspace = Effect.fn("JjWorkspaces.delete")(function* (
  workspaceRoot: string,
) {
  const root = realpath(workspaceRoot);
  const workspaces = yield* listJjWorkspaces(root).pipe(
    Effect.orElseSucceed((): ReadonlyArray<JjWorkspaceEntry> => []),
  );
  const name =
    workspaces.find((entry) => entry.root !== null && realpath(entry.root) === root)?.name ??
    NodePath.basename(root);
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
