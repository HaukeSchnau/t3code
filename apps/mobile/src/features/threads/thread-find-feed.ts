import type { OrchestrationV2SearchThreadInput, RunId } from "@t3tools/contracts";

import {
  deriveThreadFeedPresentation,
  type ThreadFeedActivity,
  type ThreadFeedEntry,
  type ThreadFeedLatestRun,
} from "../../lib/threadActivity";

export type ThreadFindStart = NonNullable<OrchestrationV2SearchThreadInput["start"]>;

/** The server names a message match by its message id and a plan match by its item id. */
function activityFindEntryId(activity: ThreadFeedActivity): string | null {
  const { item } = activity.projectedItem;
  return item.type === "proposed_plan" ? item.id : null;
}

/** The find entries a feed row shows or folds away, oldest first. */
export function threadFeedRowFindEntryIds(row: ThreadFeedEntry): ReadonlyArray<string> {
  switch (row.type) {
    case "message":
      return [row.message.id];
    case "activity-group":
    case "work-toggle":
      return row.activities.flatMap((activity) => activityFindEntryId(activity) ?? []);
    default:
      return [];
  }
}

/** The first searchable entry in a range of rows, so find counts from where the reader is. */
export function threadFindStartInRows(
  rows: ReadonlyArray<ThreadFeedEntry>,
  first: number,
  last: number,
): ThreadFindStart | undefined {
  for (let index = Math.max(0, first); index <= Math.min(last, rows.length - 1); index += 1) {
    const entryId = threadFeedRowFindEntryIds(rows[index]!)[0];
    if (entryId !== undefined) return { entryId, occurrence: 0 };
  }
  return undefined;
}

export interface ThreadFindReveal {
  /** The row that shows the entry once the folds below are open. */
  readonly rowId: string;
  readonly runId: RunId | null;
  readonly workGroupId: string | null;
  /** A plan's work row, which shows the plan text only while expanded. */
  readonly activityId: string | null;
}

function presentedRowFor(rows: ReadonlyArray<ThreadFeedEntry>, entryId: string) {
  const holds = (row: ThreadFeedEntry) => threadFeedRowFindEntryIds(row).includes(entryId);
  // An expanded group lists its items both in its toggle and in its details.
  return rows.find((row) => row.type !== "work-toggle" && holds(row)) ?? rows.find(holds);
}

/** Whether the loaded feed holds a match; when it does not, older history has to load first. */
export function threadFeedHoldsFindEntry(
  feed: ReadonlyArray<ThreadFeedEntry>,
  entryId: string,
): boolean {
  return feed.some((row) => threadFeedRowFindEntryIds(row).includes(entryId));
}

/** The run fold and work group that hide a loaded match, and the row it then appears in. */
export function resolveThreadFindReveal(input: {
  readonly feed: ReadonlyArray<ThreadFeedEntry>;
  readonly latestRun: ThreadFeedLatestRun | null;
  readonly activeWorkStartedAt: string | null;
  readonly runlessWorkActive: boolean;
  readonly expandedRunIds: ReadonlySet<RunId>;
  readonly expandedWorkGroupIds: ReadonlySet<string>;
  readonly match: { readonly entryId: string; readonly runId: RunId | null };
}): ThreadFindReveal | null {
  const { entryId } = input.match;
  const present = (runIds: ReadonlySet<RunId>, workGroupIds: ReadonlySet<string>) =>
    deriveThreadFeedPresentation(
      input.feed,
      input.latestRun,
      runIds,
      workGroupIds,
      input.activeWorkStartedAt,
      input.runlessWorkActive,
    );
  let runIds = input.expandedRunIds;
  let runId: RunId | null = null;
  let row = presentedRowFor(present(runIds, input.expandedWorkGroupIds), entryId);
  if (row === undefined && input.match.runId !== null && !runIds.has(input.match.runId)) {
    runId = input.match.runId;
    runIds = new Set([...runIds, runId]);
    row = presentedRowFor(present(runIds, input.expandedWorkGroupIds), entryId);
  }
  if (row === undefined) return null;
  let workGroupId: string | null = null;
  if (row.type === "work-toggle") {
    const details = presentedRowFor(
      present(runIds, new Set([...input.expandedWorkGroupIds, row.groupId])),
      entryId,
    );
    if (details !== undefined && details.type !== "work-toggle") {
      workGroupId = row.groupId;
      row = details;
    }
  }
  const activityId =
    row.type === "activity-group"
      ? (row.activities.find((activity) => activityFindEntryId(activity) === entryId)?.id ?? null)
      : null;
  return { rowId: row.id, runId, workGroupId, activityId };
}
