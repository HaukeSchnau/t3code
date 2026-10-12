// @effect-diagnostics nodeBuiltinImport:off -- marker lookups are synchronous filesystem probes.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface RepositoryMarker {
  readonly kind: "jj" | "git";
  readonly root: string;
  /** A jj working copy with a Git worktree beside it, so Git commands work there too. */
  readonly colocated: boolean;
}

export function realpathOrResolve(path: string): string {
  try {
    return NodeFS.realpathSync.native(path);
  } catch {
    return NodePath.resolve(path);
  }
}

/**
 * The nearest repository boundary at or above `path`. A colocated repository
 * (`.jj` next to `.git`) is a jj repository.
 */
export function findRepositoryMarker(path: string): RepositoryMarker | null {
  let current = realpathOrResolve(path);
  while (true) {
    const hasGit = NodeFS.existsSync(NodePath.join(current, ".git"));
    if (NodeFS.statSync(NodePath.join(current, ".jj"), { throwIfNoEntry: false })?.isDirectory()) {
      return { kind: "jj", root: current, colocated: hasGit };
    }
    if (hasGit) return { kind: "git", root: current, colocated: false };
    const parent = NodePath.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
