import type { WorldThreadStatus } from "@t3tools/contracts";

/** Past the longest a provider session stays pinned (4 h) plus its idle release (30 min). */
export const WORLD_QUIET_MS = 6 * 60 * 60 * 1000;

export interface WorldThreadUse {
  /** Not settled and not archived, or a run is active. */
  readonly active: boolean;
  /** The last time the thread changed, settled, archived or finished a run. */
  readonly lastActivityMs: number;
}

export type TeardownDecision =
  | { readonly teardown: true }
  | { readonly teardown: false; readonly reason: string };

/** Why a thread world must stay before anything is asked of the daemon, or undefined. */
export function busyReason(input: {
  readonly nowMs: number;
  readonly createdMs: number;
  readonly threads: ReadonlyArray<WorldThreadUse>;
}): string | undefined {
  if (input.threads.some((thread) => thread.active)) return "a thread still uses it";
  const lastMs = Math.max(input.createdMs, ...input.threads.map((t) => t.lastActivityMs));
  return input.nowMs - lastMs < WORLD_QUIET_MS
    ? "its threads were active in the last 6 hours"
    : undefined;
}

/**
 * Whether a thread world can go. It never goes while the daemon reports
 * work no remote has, or can't be asked, or while files outside the world's repos exist,
 * since no remote has those either. Threads that might still resume stay.
 */
export function teardownDecision(input: {
  readonly nowMs: number;
  /** When the thread world's directory was created. */
  readonly createdMs: number;
  /** Threads that name the thread world as their workspace; empty once they were deleted. */
  readonly threads: ReadonlyArray<WorldThreadUse>;
  /** Undefined when the daemon could not be asked. */
  readonly status: WorldThreadStatus | undefined;
  readonly looseFiles: ReadonlyArray<string>;
}): TeardownDecision {
  const busy = busyReason(input);
  if (busy !== undefined) return { teardown: false, reason: busy };
  if (input.status === undefined || !input.status.available) {
    return { teardown: false, reason: "the worldfs daemon could not be asked" };
  }
  const held = input.status.repos.filter((repo) => repo.lostOnTeardown);
  if (held.length > 0) {
    return {
      teardown: false,
      reason: `work no remote has in ${held.map((repo) => repo.repo).join(", ")}`,
    };
  }
  if (input.looseFiles.length > 0) {
    return {
      teardown: false,
      reason: `files outside the world's repos: ${input.looseFiles.slice(0, 3).join(", ")}`,
    };
  }
  return { teardown: true };
}
