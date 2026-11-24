// @effect-diagnostics nodeBuiltinImport:off -- thread worlds are identified by their host path.
/**
 * Where worlds live on the host. A world's project root is `<baseDir>/worlds/<world>`, and each
 * thread's world is a directory below it that agent-exec shows the thread at the world's path.
 */
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import type { ThreadId, WorldId, WorldSettings } from "@t3tools/contracts";

const worldsRoot = (baseDir: string) => NodePath.join(baseDir, "worlds");

export const worldProjectRoot = (baseDir: string, world: WorldId) =>
  NodePath.join(worldsRoot(baseDir), world);

/** The daemon's thread id: stable per T3 thread and within its `[A-Za-z0-9._-]`. */
export function worldThreadKey(threadId: ThreadId): string {
  return `t3-${NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 20)}`;
}

export interface ConfiguredWorld {
  readonly id: WorldId;
  readonly settings: WorldSettings;
}

function segments(baseDir: string, path: string): ReadonlyArray<string> | undefined {
  const relative = NodePath.relative(worldsRoot(baseDir), NodePath.resolve(path));
  if (relative === "" || relative.startsWith("..") || NodePath.isAbsolute(relative)) {
    return undefined;
  }
  return relative.split(NodePath.sep);
}

/** The world whose project root is `projectRoot`, if it is configured. */
export function worldOfProjectRoot(
  baseDir: string,
  worlds: Readonly<Record<WorldId, WorldSettings>>,
  projectRoot: string,
): ConfiguredWorld | undefined {
  const parts = segments(baseDir, projectRoot);
  if (parts?.length !== 1) return undefined;
  const id = parts[0] as WorldId;
  const settings = worlds[id];
  return settings === undefined ? undefined : { id, settings };
}

/** The thread world that contains `path`, if its world is configured. */
export function threadWorldOf(
  baseDir: string,
  worlds: Readonly<Record<WorldId, WorldSettings>>,
  path: string,
): (ConfiguredWorld & { readonly root: string }) | undefined {
  const parts = segments(baseDir, path);
  if (parts === undefined || parts.length < 2) return undefined;
  const id = parts[0] as WorldId;
  const settings = worlds[id];
  if (settings === undefined) return undefined;
  return { id, settings, root: NodePath.join(worldsRoot(baseDir), id, parts[1]!) };
}
