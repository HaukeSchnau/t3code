/**
 * In-thread find for clients: local matches over the loaded timeline, merged
 * with the server's matches for history the client has not loaded and for
 * detail it never receives, plus the cursor rules both clients share.
 */
import type {
  OrchestrationFindInThreadResult,
  OrchestrationThreadFindExcerpt,
  OrchestrationThreadFindField,
  OrchestrationThreadFindMatch,
  OrchestrationThreadFindSource,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2TurnItem,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import {
  compileThreadFind,
  findThreadMatches,
  THREAD_FIND_TEXT_EXCERPT,
  threadFindExcerpts,
  threadFindItemSource,
  threadFindItemText,
  type ThreadFindQuery,
} from "@t3tools/shared/threadFind";

export type ThreadFindScope = "all" | OrchestrationThreadFindSource;
export const THREAD_FIND_SCOPES: ReadonlyArray<ThreadFindScope> = [
  "all",
  "user",
  "assistant",
  "tool",
  "reasoning",
];

/** The server rejects shorter queries, so they stay local. */
export const THREAD_FIND_SERVER_MIN_LENGTH = 2;
const LOCAL_MATCH_LIMIT = 1000;

// Items are immutable snapshots, so their visible text is computed once per
// version instead of on every keystroke.
const visibleTextCache = new WeakMap<OrchestrationV2TurnItem, string>();
function visibleText(item: OrchestrationV2TurnItem): string {
  let text = visibleTextCache.get(item);
  if (text === undefined) {
    text = threadFindItemText(item).text;
    visibleTextCache.set(item, text);
  }
  return text;
}

export interface ThreadFindMatch {
  /** Stable across merges and reloads: item, field and occurrence. */
  readonly key: string;
  /** Identifies the timeline row the match lives in. */
  readonly itemKey: string;
  readonly sourceThreadId: ThreadId;
  readonly sourceItemId: TurnItemId;
  readonly source: OrchestrationThreadFindSource;
  readonly field: OrchestrationThreadFindField;
  readonly occurrence: number;
  /** False while the row is in history the client has not loaded. */
  readonly loaded: boolean;
  readonly excerpt: OrchestrationThreadFindExcerpt;
}

export interface ThreadFindResults {
  /** In timeline order, filtered to the scope. */
  readonly matches: ReadonlyArray<ThreadFindMatch>;
  /** Counts per scope across every match, so scope chips can show them. */
  readonly counts: Readonly<Record<ThreadFindScope, number>>;
  /** Set when the regex does not compile. */
  readonly invalid: string | null;
  /** The server stopped early, so there are more matches than shown. */
  readonly truncated: boolean;
}

export const threadFindItemKey = (sourceThreadId: ThreadId, sourceItemId: TurnItemId) =>
  `${sourceThreadId}:${sourceItemId}`;

const matchKey = (itemKey: string, field: OrchestrationThreadFindField, occurrence: number) =>
  `${itemKey}:${field}:${occurrence}`;

function fromServer(match: OrchestrationThreadFindMatch, loaded: boolean): ThreadFindMatch {
  const itemKey = threadFindItemKey(match.sourceThreadId, match.sourceItemId);
  return {
    key: matchKey(itemKey, match.field, match.occurrence),
    itemKey,
    sourceThreadId: match.sourceThreadId,
    sourceItemId: match.sourceItemId,
    source: match.source,
    field: match.field,
    occurrence: match.occurrence,
    loaded,
    excerpt: match.excerpt,
  };
}

const EMPTY_COUNTS: Record<ThreadFindScope, number> = {
  all: 0,
  user: 0,
  assistant: 0,
  tool: 0,
  reasoning: 0,
};

/**
 * Loaded rows are a contiguous suffix of the timeline, so server matches for
 * rows the client lacks come first. For loaded rows the client's own count of
 * visible text wins, since it reflects live updates; the server adds detail.
 */
export function deriveThreadFindResults(input: {
  /** Every loaded timeline row, oldest first. */
  readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly query: ThreadFindQuery;
  readonly scope: ThreadFindScope;
  readonly server: OrchestrationFindInThreadResult | null;
  /** Rows the client does not show are neither searched nor navigated to. */
  readonly isRendered?: (row: OrchestrationV2ProjectedTurnItem) => boolean;
}): ThreadFindResults {
  const matcher = compileThreadFind(input.query);
  if (matcher === null)
    return { matches: [], counts: EMPTY_COUNTS, invalid: null, truncated: false };
  if (matcher._tag === "Invalid") {
    return { matches: [], counts: EMPTY_COUNTS, invalid: matcher.message, truncated: false };
  }

  const loadedKeys = new Set(
    input.items.map((row) => threadFindItemKey(row.sourceThreadId, row.sourceItemId)),
  );
  const rendered = input.isRendered ? input.items.filter(input.isRendered) : input.items;
  const renderedKeys = new Set(
    rendered.map((row) => threadFindItemKey(row.sourceThreadId, row.sourceItemId)),
  );
  const all: Array<ThreadFindMatch> = [];
  const detailByItem = new Map<string, Array<ThreadFindMatch>>();
  for (const match of input.server?.matches ?? []) {
    const itemKey = threadFindItemKey(match.sourceThreadId, match.sourceItemId);
    if (!loadedKeys.has(itemKey)) {
      all.push(fromServer(match, false));
    } else if (match.field === "detail" && renderedKeys.has(itemKey)) {
      const list = detailByItem.get(itemKey) ?? [];
      list.push(fromServer(match, true));
      detailByItem.set(itemKey, list);
    }
  }

  let localCount = 0;
  for (const row of rendered) {
    const itemKey = threadFindItemKey(row.sourceThreadId, row.sourceItemId);
    if (localCount < LOCAL_MATCH_LIMIT) {
      const text = visibleText(row.item);
      const ranges = findThreadMatches(matcher, text, LOCAL_MATCH_LIMIT - localCount);
      localCount += ranges.length;
      const source = threadFindItemSource(row.item);
      threadFindExcerpts(text, ranges, THREAD_FIND_TEXT_EXCERPT).forEach((excerpt, occurrence) =>
        all.push({
          key: matchKey(itemKey, "text", occurrence),
          itemKey,
          sourceThreadId: row.sourceThreadId,
          sourceItemId: row.sourceItemId,
          source,
          field: "text",
          occurrence,
          loaded: true,
          excerpt,
        }),
      );
    }
    all.push(...(detailByItem.get(itemKey) ?? []));
  }

  const counts = { ...EMPTY_COUNTS, all: all.length };
  for (const match of all) counts[match.source] += 1;
  return {
    matches: input.scope === "all" ? all : all.filter((match) => match.source === input.scope),
    counts,
    invalid: null,
    truncated: (input.server?.truncated ?? false) || localCount >= LOCAL_MATCH_LIMIT,
  };
}

/**
 * The selected match, by key so it survives merges and streaming. While
 * `anchored`, the selection follows the match nearest to where the reader
 * was; picking or stepping ends that, so late results never move it.
 */
export interface ThreadFindCursor {
  readonly key: string | null;
  readonly anchored: boolean;
}

export const THREAD_FIND_CURSOR_START: ThreadFindCursor = { key: null, anchored: true };

/**
 * The last match at or above the bottom of the reader's viewport. Rows the
 * client has not loaded sit above everything loaded, so they win only when
 * no loaded match qualifies.
 */
export function nearestThreadFindMatch(
  matches: ReadonlyArray<ThreadFindMatch>,
  isAtOrAboveViewportBottom: (match: ThreadFindMatch) => boolean,
): number {
  let best = -1;
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    if (!match.loaded || isAtOrAboveViewportBottom(match)) best = index;
    else break;
  }
  return best !== -1 ? best : matches.length > 0 ? 0 : -1;
}

export type ThreadFindCursorEvent =
  /** The query, its options or the thread changed. */
  | { readonly type: "query" }
  /** Matches were recomputed. `settled` when a server answer just arrived. */
  | { readonly type: "results"; readonly settled: boolean }
  | { readonly type: "pick"; readonly index: number }
  | { readonly type: "step"; readonly direction: "older" | "newer" };

export interface ThreadFindCursorState {
  readonly cursor: ThreadFindCursor;
  /** Index into the matches, or -1. */
  readonly index: number;
  /** Set when a step went past the end and came around. */
  readonly wrapped: "to-newest" | "to-oldest" | null;
}

export function reduceThreadFindCursor(
  cursor: ThreadFindCursor,
  matches: ReadonlyArray<ThreadFindMatch>,
  event: ThreadFindCursorEvent,
  nearest: () => number,
): ThreadFindCursorState {
  const at = (
    index: number,
    anchored: boolean,
    wrapped: ThreadFindCursorState["wrapped"] = null,
  ) => ({
    cursor: { key: matches[index]?.key ?? null, anchored },
    index: matches[index] === undefined ? -1 : index,
    wrapped,
  });
  const current = cursor.key === null ? -1 : matches.findIndex((match) => match.key === cursor.key);
  switch (event.type) {
    case "query":
      return at(nearest(), true);
    case "results":
      if (cursor.anchored && (event.settled || current === -1)) return at(nearest(), true);
      return current === -1 ? at(nearest(), cursor.anchored) : at(current, cursor.anchored);
    case "pick":
      return at(event.index, false);
    case "step": {
      if (matches.length === 0) return at(-1, false);
      if (event.direction === "older") {
        if (current === -1) return at(matches.length - 1, false);
        return current > 0 ? at(current - 1, false) : at(matches.length - 1, false, "to-newest");
      }
      if (current === -1) return at(0, false);
      return current < matches.length - 1 ? at(current + 1, false) : at(0, false, "to-oldest");
    }
  }
}
