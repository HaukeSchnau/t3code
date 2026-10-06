// @effect-diagnostics nodeBuiltinImport:off -- free-space and filesystem-type checks need statfs, which Effect's FileSystem does not expose.
/**
 * Guarded directory copies as workspaces for projects without a repository.
 * Copy-on-write clones (APFS, BTRFS) are bounded by a transient-space budget;
 * full copies need a size limit and free space, and a failed clone never falls
 * back to a full copy that those checks would refuse.
 *
 * @module DirectoryCopyWorkspaces
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import {
  ManagedWorkspaceError,
  removeWorkspaceDirectory,
  runWorkspaceCommandOrFail,
} from "./WorkspaceCommand.ts";

const GIB = 1024 * 1024 * 1024;
const MAX_SOURCE_BYTES_DEFAULT = 5 * GIB;
const MIN_FREE_BYTES = GIB;
const COPY_ON_WRITE_MAX_TRANSIENT_BYTES = 2 * GIB;
const APFS_STATFS_TYPE = 26;
const BTRFS_STATFS_TYPE = 0x9123683e;

type CopyOnWriteKind = "apfs-clone" | "btrfs-reflink";

interface FileSystemFacts {
  readonly platform: NodeJS.Platform;
  readonly sourceDevice: number | null;
  readonly destinationDevice: number | null;
  readonly sourceFileSystem: number | null;
  readonly destinationFileSystem: number | null;
}

/** BTRFS reflinks work across subvolumes, which report different devices; APFS clones do not. */
export function copyOnWriteKind(facts: FileSystemFacts): CopyOnWriteKind | null {
  if (
    facts.platform === "darwin" &&
    facts.sourceDevice !== null &&
    facts.sourceDevice === facts.destinationDevice &&
    facts.sourceFileSystem === APFS_STATFS_TYPE &&
    facts.destinationFileSystem === APFS_STATFS_TYPE
  ) {
    return "apfs-clone";
  }
  if (
    facts.platform === "linux" &&
    facts.sourceFileSystem === BTRFS_STATFS_TYPE &&
    facts.destinationFileSystem === BTRFS_STATFS_TYPE
  ) {
    return "btrfs-reflink";
  }
  return null;
}

function fullCopyRequiredBytes(sourceBytes: number): number {
  return Math.max(MIN_FREE_BYTES, Math.ceil(sourceBytes * 1.1));
}

/** After a failed clone, a full copy must pass the checks a non-clone copy would face. */
export function fullCopyFallbackAllowed(input: {
  readonly sourceBytes: number;
  readonly maxSourceBytes: number;
  readonly availableBytes: number;
}): boolean {
  return (
    input.sourceBytes <= input.maxSourceBytes &&
    input.availableBytes >= fullCopyRequiredBytes(input.sourceBytes)
  );
}

function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalize = (path: string) =>
    platform === "win32" ? NodePath.resolve(path).toLowerCase() : NodePath.resolve(path);
  return normalize(left) === normalize(right);
}

function isInside(candidate: string, parent: string): boolean {
  const relative = NodePath.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

function realpathOrResolve(path: string): string {
  try {
    return NodeFS.realpathSync.native(path);
  } catch {
    return NodePath.resolve(path);
  }
}

/** Resolves symlinks in the existing part of a path that does not exist yet. */
function realpathForNewPath(path: string): string {
  const missing: string[] = [];
  let existing = NodePath.resolve(path);
  while (!NodeFS.existsSync(existing)) {
    const parent = NodePath.dirname(existing);
    if (parent === existing) return NodePath.resolve(path);
    missing.unshift(NodePath.basename(existing));
    existing = parent;
  }
  return NodePath.join(realpathOrResolve(existing), ...missing);
}

/** Why copying `source` is unsafe, or null. */
function sensitiveSourceReason(input: {
  readonly source: string;
  readonly destination: string;
  readonly baseDir: string;
  readonly workspacesRoot: string;
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
}): string | null {
  if (isInside(input.destination, input.source)) {
    return `The workspace '${input.destination}' would be created inside the project '${input.source}'.`;
  }
  const sensitive = [
    NodePath.parse(input.source).root,
    input.homeDir,
    realpathOrResolve(input.baseDir),
    realpathOrResolve(input.workspacesRoot),
    NodePath.join(input.homeDir, ".t3"),
    NodePath.join(input.homeDir, ".codex"),
    NodePath.join(input.homeDir, ".ssh"),
    NodePath.join(input.homeDir, "Library"),
  ].find((root) => samePath(input.source, root, input.platform));
  return sensitive === undefined
    ? null
    : `Workspaces cannot copy the sensitive directory '${sensitive}'.`;
}

/** The statfs magic number, unsigned so BTRFS's high-bit value compares reliably. */
const fileSystemType = (path: string) => {
  try {
    return Number(NodeFS.statfsSync(path).type) >>> 0;
  } catch {
    return null;
  }
};

const availableBytes = (path: string) => {
  const stat = NodeFS.statfsSync(path);
  return Number(stat.bavail) * Number(stat.bsize);
};

const fail = (detail: string, cause?: unknown) =>
  new ManagedWorkspaceError({
    operation: "DirectoryCopyWorkspaces.create",
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const measureBytes = Effect.fn("DirectoryCopyWorkspaces.measure")(function* (source: string) {
  const output = yield* runWorkspaceCommandOrFail({
    operation: "DirectoryCopyWorkspaces.measure",
    command: "du",
    args: ["-sk", source],
    timeout: "30 seconds",
    maxOutputBytes: 4096,
  });
  const kibibytes = Number.parseInt(output.split(/\s+/)[0] ?? "", 10);
  if (!Number.isFinite(kibibytes)) {
    return yield* fail(`Could not measure the size of '${source}'.`);
  }
  return kibibytes * 1024;
});

/** Fails the copy when free space drops below the floor or the clone grows past its budget. */
const watchFreeSpace = (destinationParent: string, initialAvailable: number) =>
  Effect.suspend(() => {
    const available = availableBytes(destinationParent);
    const consumed = Math.max(0, initialAvailable - available);
    if (available < MIN_FREE_BYTES) {
      return Effect.fail(
        fail(`The copy stopped because free space fell below ${formatBytes(MIN_FREE_BYTES)}.`),
      );
    }
    if (consumed > COPY_ON_WRITE_MAX_TRANSIENT_BYTES) {
      return Effect.fail(
        fail(
          `The copy stopped after using ${formatBytes(consumed)}, more than the ${formatBytes(COPY_ON_WRITE_MAX_TRANSIENT_BYTES)} a copy-on-write clone may use.`,
        ),
      );
    }
    return Effect.void;
  }).pipe(Effect.repeat(Schedule.spaced(Duration.seconds(1))), Effect.andThen(Effect.never));

const copy = (command: string, args: ReadonlyArray<string>) =>
  runWorkspaceCommandOrFail({
    operation: "DirectoryCopyWorkspaces.copy",
    command,
    args,
    timeout: "20 minutes",
    maxOutputBytes: 256 * 1024,
  });

/** Copies `source` to the new directory `destination`, which must not exist yet. */
export const createDirectoryCopy = Effect.fn("DirectoryCopyWorkspaces.create")(function* (input: {
  readonly source: string;
  readonly destination: string;
  readonly baseDir: string;
  readonly workspacesRoot: string;
}) {
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  const source = realpathOrResolve(input.source);
  if (!NodeFS.statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
    return yield* fail(`The project '${source}' is not a directory.`);
  }
  const unsafe = sensitiveSourceReason({
    source,
    destination: realpathForNewPath(input.destination),
    baseDir: input.baseDir,
    workspacesRoot: input.workspacesRoot,
    homeDir: NodeOS.homedir(),
    platform,
  });
  if (unsafe !== null) return yield* fail(unsafe);
  if (NodeFS.existsSync(input.destination)) {
    return yield* fail(`The workspace '${input.destination}' already exists.`);
  }

  const destinationParent = NodePath.dirname(input.destination);
  NodeFS.mkdirSync(destinationParent, { recursive: true });
  const clone = copyOnWriteKind({
    platform,
    sourceDevice: NodeFS.statSync(source).dev,
    destinationDevice: NodeFS.statSync(destinationParent).dev,
    sourceFileSystem: fileSystemType(source),
    destinationFileSystem: fileSystemType(destinationParent),
  });
  const sourceBytes = yield* measureBytes(source);
  const configuredMax = Number(environment.T3CODE_DIRECTORY_COPY_MAX_BYTES);
  const maxSourceBytes =
    Number.isFinite(configuredMax) && configuredMax > 0
      ? Math.floor(configuredMax)
      : MAX_SOURCE_BYTES_DEFAULT;
  if (clone === null && sourceBytes > maxSourceBytes) {
    return yield* fail(
      `The project is ${formatBytes(sourceBytes)}, more than the ${formatBytes(maxSourceBytes)} a workspace copy may use.`,
    );
  }
  const available = availableBytes(destinationParent);
  const required =
    clone === null
      ? fullCopyRequiredBytes(sourceBytes)
      : Math.max(MIN_FREE_BYTES, COPY_ON_WRITE_MAX_TRANSIENT_BYTES);
  if (available < required) {
    return yield* fail(
      `A workspace copy needs ${formatBytes(required)} free, but only ${formatBytes(available)} is available.`,
    );
  }

  const fullCopy = copy("cp", ["-R", source, input.destination]);
  const cloned =
    clone === null
      ? fullCopy
      : Effect.raceFirst(
          clone === "apfs-clone"
            ? copy("/bin/cp", ["-cR", source, input.destination])
            : copy("cp", ["-a", "--reflink=always", source, input.destination]),
          watchFreeSpace(destinationParent, available),
        ).pipe(
          Effect.catch((cause) =>
            fullCopyFallbackAllowed({ sourceBytes, maxSourceBytes, availableBytes: available })
              ? removeWorkspaceDirectory(input.destination).pipe(Effect.andThen(fullCopy))
              : Effect.fail(
                  fail("The copy-on-write clone failed and a full copy is not safe here.", cause),
                ),
          ),
        );
  yield* cloned.pipe(
    Effect.onError(() => removeWorkspaceDirectory(input.destination).pipe(Effect.ignore)),
  );
  return input.destination;
});
