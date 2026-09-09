import type { ArchivedSnapshotEntry } from "./threads";
import type { ThreadWorkspaceId } from "@t3tools/contracts";

interface WorkspaceThread {
  readonly id: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly workspaceId?: ThreadWorkspaceId | null | undefined;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly archivedAt: string | null;
  readonly session?: { readonly status: string } | null | undefined;
}

export interface ThreadWorkspaceGroup<T> {
  readonly key: string;
  readonly workspaceId: ThreadWorkspaceId | null;
  readonly checkoutPath: string;
  readonly label: string;
  readonly branch: string | null;
  readonly threads: ReadonlyArray<T>;
  readonly settled: boolean;
  readonly runningCount: number;
}

export function workspaceLabel(checkoutPath: string): string {
  return (
    checkoutPath
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) || "Workspace"
  );
}

/** Reuse the callers' thread lifecycle decisions. A workspace has no second
 * settlement timer, and snoozing a conversation does not finish its work. */
export function groupThreadsByWorkspace<T extends WorkspaceThread>(
  threads: ReadonlyArray<T>,
  isSettled: (thread: T) => boolean,
): ReadonlyArray<ThreadWorkspaceGroup<T>> {
  const groups = new Map<
    string,
    {
      key: string;
      workspaceId: ThreadWorkspaceId | null;
      checkoutPath: string;
      label: string;
      branch: string | null;
      threads: T[];
      settled: boolean;
      runningCount: number;
    }
  >();
  for (const thread of threads) {
    if (!thread.worktreePath) continue;
    // Older clients attached threads by path and could create duplicate workspace
    // records. Scope paths to their host and project while those records coexist.
    const key = JSON.stringify([thread.environmentId, thread.projectId, thread.worktreePath]);
    const previous = groups.get(key);
    const settled = thread.archivedAt !== null || isSettled(thread);
    const running = thread.session?.status === "running" || thread.session?.status === "starting";
    if (previous) {
      previous.workspaceId ??= thread.workspaceId ?? null;
      previous.branch ??= thread.branch;
      previous.threads.push(thread);
      previous.settled &&= settled && !running;
      previous.runningCount += Number(running);
    } else {
      groups.set(key, {
        key,
        workspaceId: thread.workspaceId ?? null,
        checkoutPath: thread.worktreePath,
        label: workspaceLabel(thread.worktreePath),
        branch: thread.branch,
        threads: [thread],
        settled: settled && !running,
        runningCount: Number(running),
      });
    }
  }
  return [...groups.values()];
}

/** Search includes settled workspaces; merely browsing them changes no lifecycle. */
export function filterWorkspaceGroups<T>(
  groups: ReadonlyArray<ThreadWorkspaceGroup<T>>,
  options: { readonly query: string; readonly showSettled: boolean },
): ReadonlyArray<ThreadWorkspaceGroup<T>> {
  const query = options.query.trim().toLocaleLowerCase();
  return groups.filter((group) =>
    query
      ? `${group.label} ${group.branch ?? ""}`.toLocaleLowerCase().includes(query)
      : options.showSettled || !group.settled,
  );
}

/** Archived shells are loaded on demand through the existing archive query. */
export function withArchivedWorkspaces(
  current: ReadonlyArray<ThreadWorkspaceGroup<unknown>>,
  snapshots: ReadonlyArray<ArchivedSnapshotEntry>,
  projectId: string,
): ReadonlyArray<ThreadWorkspaceGroup<unknown>> {
  const archived = groupThreadsByWorkspace(
    snapshots.flatMap(({ environmentId, snapshot }) =>
      snapshot.threads
        .filter((thread) => thread.projectId === projectId)
        .map((thread) => ({ ...thread, environmentId })),
    ),
    () => true,
  );
  return [...new Map([...archived, ...current].map((group) => [group.key, group])).values()];
}
