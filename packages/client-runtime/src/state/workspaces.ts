/**
 * Workspace lists for the fork's workspace pickers (patches/workspaces.md). A
 * workspace is the directory threads share through `worktreePath`, so the list
 * is derived from thread shells; archived shells are merged in on demand
 * through the existing archive query. Browsing settled workspaces changes no
 * lifecycle state.
 */
import * as DateTime from "effect/DateTime";

import type { ArchivedSnapshotEntry } from "./archivedThreads.ts";
import { type EnvironmentThreadShell, threadRuntimeIsActive } from "./models.ts";

export interface WorkspaceThread {
  readonly environmentId: string;
  readonly projectId: string;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  /** Archived, or settled by the user or automatic settlement. */
  readonly settled: boolean;
  readonly running: boolean;
  readonly updatedAtMs: number;
}

interface WorkspaceGroup {
  readonly key: string;
  readonly path: string;
  readonly label: string;
  readonly branch: string | null;
  readonly threadCount: number;
  readonly runningCount: number;
  /** Every thread is settled or archived and none is running. */
  readonly settled: boolean;
  readonly updatedAtMs: number;
}

export function workspaceLabel(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) || "Workspace"
  );
}

function workspaceThreadFromShell(thread: EnvironmentThreadShell): WorkspaceThread {
  return {
    environmentId: thread.environmentId,
    projectId: thread.projectId,
    worktreePath: thread.worktreePath,
    branch: thread.branch,
    settled: thread.archivedAt !== null || thread.settledOverride === "settled",
    running: threadRuntimeIsActive(thread.runtime),
    updatedAtMs: Date.parse(thread.updatedAt) || 0,
  };
}

function workspaceThreadsFromArchive(
  snapshots: ReadonlyArray<ArchivedSnapshotEntry>,
): ReadonlyArray<WorkspaceThread> {
  return snapshots.flatMap(({ environmentId, snapshot }) =>
    snapshot.threads.map((thread) => ({
      environmentId,
      projectId: thread.projectId,
      worktreePath: thread.worktreePath,
      branch: thread.branch,
      settled: true,
      running: thread.activityRunStatus != null,
      updatedAtMs: DateTime.toEpochMillis(thread.updatedAt),
    })),
  );
}

/**
 * One group per environment, project and path. Running workspaces come first,
 * then the most recently updated.
 */
export function groupThreadsByWorkspace(
  threads: ReadonlyArray<WorkspaceThread>,
): ReadonlyArray<WorkspaceGroup> {
  const groups = new Map<string, WorkspaceGroup>();
  for (const thread of threads) {
    if (thread.worktreePath === null) continue;
    const key = JSON.stringify([thread.environmentId, thread.projectId, thread.worktreePath]);
    const previous = groups.get(key);
    groups.set(key, {
      key,
      path: thread.worktreePath,
      label: workspaceLabel(thread.worktreePath),
      branch: previous?.branch ?? thread.branch,
      threadCount: (previous?.threadCount ?? 0) + 1,
      runningCount: (previous?.runningCount ?? 0) + Number(thread.running),
      settled: (previous?.settled ?? true) && thread.settled && !thread.running,
      updatedAtMs: Math.max(previous?.updatedAtMs ?? 0, thread.updatedAtMs),
    });
  }
  return [...groups.values()].sort(
    (left, right) =>
      Number(right.runningCount > 0) - Number(left.runningCount > 0) ||
      right.updatedAtMs - left.updatedAtMs,
  );
}

/** Settled workspaces stay hidden unless asked for; a search finds them too. */
export function filterWorkspaceGroups(
  groups: ReadonlyArray<WorkspaceGroup>,
  options: { readonly query: string; readonly showSettled: boolean },
): ReadonlyArray<WorkspaceGroup> {
  const query = options.query.trim().toLocaleLowerCase();
  return groups.filter((group) =>
    query.length > 0
      ? `${group.label} ${group.branch ?? ""} ${group.path}`.toLocaleLowerCase().includes(query)
      : options.showSettled || !group.settled,
  );
}

/** The picker's list for one project. Archived threads join once the caller loads them. */
export function projectWorkspaceGroups(input: {
  readonly projectId: string;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly archived: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly query: string;
  readonly showSettled: boolean;
}): ReadonlyArray<WorkspaceGroup> {
  const live = input.threads.map(workspaceThreadFromShell);
  return filterWorkspaceGroups(
    groupThreadsByWorkspace(
      [...live, ...workspaceThreadsFromArchive(input.archived)].filter(
        (thread) => thread.projectId === input.projectId,
      ),
    ),
    input,
  );
}
