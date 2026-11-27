// @effect-diagnostics nodeBuiltinImport:off -- a record's file name is a hash of its workspace path.
/**
 * jj workspaces that storage cleanup removed while a thread may still resume in them. Turn start
 * recreates one at the commit it was on (patches/workspaces.md).
 */
import * as NodeCrypto from "node:crypto";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const RemovedJjWorkspace = Schema.Struct({
  root: Schema.String,
  name: Schema.String,
  revisions: Schema.Array(Schema.String.check(Schema.isPattern(/^[0-9a-f]{40,64}$/))),
});
export type RemovedJjWorkspace = typeof RemovedJjWorkspace.Type;
const RemovedJjWorkspaceJson = Schema.fromJsonString(RemovedJjWorkspace);
const decode = Schema.decodeUnknownEffect(RemovedJjWorkspaceJson);
const encode = Schema.encodeEffect(RemovedJjWorkspaceJson);

/** The managed workspace, `<workspaces>/<project>/<name>`, that holds `target`, in the spelling of the first root that does. */
export const managedWorkspaceRootOf = (
  workspacesRoots: ReadonlyArray<string>,
  target: string,
  path: Path.Path,
): string | null => {
  for (const root of workspacesRoots) {
    const relative = path.relative(root, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      continue;
    const [project, name] = relative.split(path.sep);
    if (project !== undefined && project !== "" && name !== undefined)
      return path.join(root, project, name);
  }
  return null;
};

export const removedJjWorkspacesDirectory = (stateDir: string, path: Path.Path) =>
  path.join(stateDir, "removed-jj-workspaces");

const recordPath = (directory: string, root: string, path: Path.Path) =>
  path.join(
    directory,
    `${NodeCrypto.createHash("sha256").update(root).digest("hex").slice(0, 32)}.json`,
  );

export const recordRemovedJjWorkspace = Effect.fn("RemovedJjWorkspaces.record")(function* (
  directory: string,
  record: RemovedJjWorkspace,
) {
  const path = yield* Path.Path;
  yield* writeFileStringAtomically({
    filePath: recordPath(directory, record.root, path),
    contents: `${yield* encode(record)}\n`,
  });
});

export const readRemovedJjWorkspace = Effect.fn("RemovedJjWorkspaces.read")(function* (
  directory: string,
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const record = yield* fs
    .readFileString(recordPath(directory, root, path))
    .pipe(Effect.flatMap(decode), Effect.option);
  return Option.filter(record, (entry) => entry.root === root);
});

export const forgetRemovedJjWorkspace = Effect.fn("RemovedJjWorkspaces.forget")(function* (
  directory: string,
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.remove(recordPath(directory, root, path), { force: true });
});

/** Drops records whose workspace no remaining thread can resume in. */
export const pruneRemovedJjWorkspaces = Effect.fn("RemovedJjWorkspaces.prune")(function* (
  directory: string,
  inUse: (root: string) => boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(directory, name);
    const record = yield* fs.readFileString(file).pipe(Effect.flatMap(decode), Effect.option);
    if (Option.isSome(record) && inUse(record.value.root)) continue;
    yield* fs.remove(file, { force: true });
  }
});
