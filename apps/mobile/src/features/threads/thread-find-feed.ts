import { threadFindItemKey, type ThreadFindMatch } from "@t3tools/client-runtime/thread-find";
import type {
  OrchestrationFindInThreadResult,
  OrchestrationThreadFindExcerpt,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2TurnItem,
  RunId,
} from "@t3tools/contracts";
import {
  THREAD_FIND_TEXT_EXCERPT,
  threadFindExcerpts,
  threadFindItemText,
  type ThreadFindRange,
} from "@t3tools/shared/threadFind";

import {
  deriveThreadFeedPresentation,
  threadFeedFoldedEntryRuns,
  type ThreadFeedEntry,
  type ThreadFeedLatestRun,
} from "../../lib/threadActivity";

const projectedItemKey = (row: OrchestrationV2ProjectedTurnItem) =>
  threadFindItemKey(row.sourceThreadId, row.sourceItemId);

/** The timeline items a feed row shows or folds away, oldest first. */
export function threadFeedRowItemKeys(row: ThreadFeedEntry): ReadonlyArray<string> {
  switch (row.type) {
    case "message":
      return row.message.projectedItem ? [projectedItemKey(row.message.projectedItem)] : [];
    case "activity-group":
    case "work-toggle":
      return row.activities.map((activity) => projectedItemKey(activity.projectedItem));
    case "run-fold":
    case "thinking":
      return [];
  }
}

/**
 * Find covers what the feed renders. Rows it never shows, such as todo lists
 * and checkpoints, leave the local items, and their server matches go too:
 * otherwise a loaded but hidden row would read as history still to load.
 */
export function threadFindSearchScope(input: {
  readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly feed: ReadonlyArray<ThreadFeedEntry>;
  readonly server: OrchestrationFindInThreadResult | null;
}): {
  readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly server: OrchestrationFindInThreadResult | null;
} {
  const shown = new Set(input.feed.flatMap(threadFeedRowItemKeys));
  const hidden = new Set(
    input.items.map(projectedItemKey).filter((itemKey) => !shown.has(itemKey)),
  );
  if (hidden.size === 0) return input;
  return {
    items: input.items.filter((row) => !hidden.has(projectedItemKey(row))),
    server: input.server && {
      ...input.server,
      matches: input.server.matches.filter(
        (match) => !hidden.has(threadFindItemKey(match.sourceThreadId, match.sourceItemId)),
      ),
    },
  };
}

/** The last item shown at or above a list position, so find can start where the reader was. */
export function threadFindAnchorItemKey(
  rows: ReadonlyArray<ThreadFeedEntry>,
  index: number,
): string | null {
  for (let row = Math.min(index, rows.length - 1); row >= 0; row -= 1) {
    const itemKey = threadFeedRowItemKeys(rows[row]!).at(-1);
    if (itemKey !== undefined) return itemKey;
  }
  return null;
}

function presentedRowFor(rows: ReadonlyArray<ThreadFeedEntry>, itemKey: string) {
  const holds = (row: ThreadFeedEntry) => threadFeedRowItemKeys(row).includes(itemKey);
  // An expanded group lists its items both in its toggle and in its details.
  return rows.find((row) => row.type !== "work-toggle" && holds(row)) ?? rows.find(holds);
}

export interface ThreadFindReveal {
  /** The row that shows the item once the folds below are open. */
  readonly rowId: string;
  readonly runId: RunId | null;
  readonly workGroupId: string | null;
}

/** The run fold and work group that hide an item, and the row it then appears in. */
export function resolveThreadFindReveal(input: {
  readonly feed: ReadonlyArray<ThreadFeedEntry>;
  readonly latestRun: ThreadFeedLatestRun | null;
  readonly activeWorkStartedAt: string | null;
  readonly runlessWorkActive: boolean;
  readonly expandedRunIds: ReadonlySet<RunId>;
  readonly expandedWorkGroupIds: ReadonlySet<string>;
  readonly itemKey: string;
}): ThreadFindReveal | null {
  const entry = input.feed.find((row) => threadFeedRowItemKeys(row).includes(input.itemKey));
  if (entry === undefined) return null;
  const foldRunId = threadFeedFoldedEntryRuns(
    input.feed,
    input.latestRun,
    input.activeWorkStartedAt,
  ).get(entry.id);
  const runId = foldRunId !== undefined && !input.expandedRunIds.has(foldRunId) ? foldRunId : null;
  const runIds = runId === null ? input.expandedRunIds : new Set([...input.expandedRunIds, runId]);
  const present = (workGroupIds: ReadonlySet<string>) =>
    deriveThreadFeedPresentation(
      input.feed,
      input.latestRun,
      runIds,
      workGroupIds,
      input.activeWorkStartedAt,
      input.runlessWorkActive,
    );
  const row = presentedRowFor(present(input.expandedWorkGroupIds), input.itemKey);
  if (row === undefined) return null;
  if (row.type !== "work-toggle") return { rowId: row.id, runId, workGroupId: null };
  const details = presentedRowFor(
    present(new Set([...input.expandedWorkGroupIds, row.groupId])),
    input.itemKey,
  );
  return details === undefined || details.type === "work-toggle"
    ? null
    : { rowId: details.id, runId, workGroupId: row.groupId };
}

/**
 * The excerpt a row shows for its current match. The match keeps the excerpt
 * from when it was selected, so streaming does not re-render every row; text
 * excerpts come from the row's own item instead, which re-renders as it streams.
 */
export function threadFindRowExcerpt(
  match: ThreadFindMatch,
  item: OrchestrationV2TurnItem,
  find: (text: string) => ReadonlyArray<ThreadFindRange>,
): OrchestrationThreadFindExcerpt {
  if (match.field !== "text") return match.excerpt;
  const { text } = threadFindItemText(item);
  const range = find(text)[match.occurrence];
  return (range && threadFindExcerpts(text, [range], THREAD_FIND_TEXT_EXCERPT)[0]) ?? match.excerpt;
}

/** One line around a match, for the match list. */
export function threadFindSnippet(
  excerpt: OrchestrationThreadFindExcerpt,
  context = 32,
): { readonly before: string; readonly match: string; readonly after: string } {
  const { text, start, end } = excerpt;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const newline = text.indexOf("\n", start + 1);
  const lineEnd = newline === -1 ? text.length : newline;
  const matchEnd = Math.min(end, lineEnd);
  const oneLine = (value: string) => value.replace(/\s+/g, " ");
  const before = oneLine(text.slice(lineStart, start)).trimStart();
  return {
    before: before.length > context ? `…${before.slice(-context).trimStart()}` : before,
    match: oneLine(text.slice(start, matchEnd)),
    after: oneLine(text.slice(matchEnd, lineEnd)),
  };
}
