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

const ABSENT_CODES = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM"]);

/** A missing or unreadable path counts as absent; any other error is rethrown. */
function isDirectory(path: string): boolean {
  try {
    return NodeFS.statSync(path).isDirectory();
  } catch (error) {
    if (ABSENT_CODES.has((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
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
    if (isDirectory(NodePath.join(current, ".jj"))) {
      return { kind: "jj", root: current, colocated: hasGit };
    }
    if (hasGit) return { kind: "git", root: current, colocated: false };
    const parent = NodePath.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
