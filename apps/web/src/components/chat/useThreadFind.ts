import type { LegendListRef } from "@legendapp/list/react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  deriveThreadFindResults,
  nearestThreadFindMatch,
  reduceThreadFindCursor,
  THREAD_FIND_CURSOR_START,
  THREAD_FIND_SCOPES,
  THREAD_FIND_SERVER_MIN_LENGTH,
  type ThreadFindCursor,
  type ThreadFindCursorEvent,
  type ThreadFindMatch,
  type ThreadFindResults,
} from "@t3tools/client-runtime/thread-find";
import type { OrchestrationV2ProjectedTurnItem, ScopedThreadRef } from "@t3tools/contracts";
import { compileThreadFind, type ThreadFindQuery } from "@t3tools/shared/threadFind";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import type { TimelineEntry } from "../../session-logic";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useDebouncedValue } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { useThreadFindStore } from "../../threadFindStore";
import { buildThreadFindEntryIndex, isAtOrAboveOrigin } from "./threadFind.logic";
import type { ThreadFindTimelineState, ThreadFindTimelineTarget } from "./threadFindTimeline";

// Mirrors the sidebar's thread search debounce.
const SERVER_DEBOUNCE_MS = 200;
// New or finished tool rows may hold matches; streaming text never does.
const SERVER_REFRESH_DELAY_MS = 1000;
const MAX_HISTORY_PAGES = 20;
const BACK_PILL_MS = 6000;

export interface ThreadFindHistory {
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly onLoadEarlier: () => void;
}

interface CursorState {
  readonly cursor: ThreadFindCursor;
  readonly index: number;
  /** The match navigated to, kept as it was so streaming does not churn it. */
  readonly match: ThreadFindMatch | null;
  /** Bumped by every navigation the timeline must perform. */
  readonly requestId: number;
}

const NO_RESULTS: ThreadFindResults = {
  matches: [],
  counts: { all: 0, user: 0, assistant: 0, tool: 0, reasoning: 0 },
  invalid: null,
  truncated: false,
};

// Matches keep their identity while their items are unchanged, so this holds
// whenever streaming touched nothing that matches.
function sameResults(left: ThreadFindResults, right: ThreadFindResults): boolean {
  return (
    left.invalid === right.invalid &&
    left.truncated === right.truncated &&
    left.matches.length === right.matches.length &&
    left.matches.every((match, index) => match === right.matches[index]) &&
    THREAD_FIND_SCOPES.every((scope) => left.counts[scope] === right.counts[scope])
  );
}

/** Where the reader is: the newest entry showing above the viewport bottom. */
function readerEntryId(
  viewport: HTMLElement,
  orderByEntryId: ReadonlyMap<string, number>,
): string | null {
  const bottom = viewport.getBoundingClientRect().bottom;
  let best: { readonly id: string; readonly order: number } | null = null;
  for (const element of viewport.querySelectorAll<HTMLElement>("[data-find-entry]")) {
    const rect = element.getBoundingClientRect();
    if (rect.height === 0 || rect.top >= bottom) continue;
    const id = element.dataset.findEntry ?? "";
    const order = orderByEntryId.get(id);
    if (order !== undefined && (best === null || order > best.order)) best = { id, order };
  }
  return best?.id ?? null;
}

/**
 * The scroll position as the topmost visible row plus an offset into it, so
 * returning there survives history prepended above it.
 */
interface ScrollHome {
  readonly rowKey: string | null;
  readonly delta: number;
  readonly scrollTop: number;
}

function captureScrollHome(list: LegendListRef): ScrollHome | null {
  const viewport = list.getScrollableNode();
  if (!viewport) return null;
  const top = viewport.getBoundingClientRect().top;
  let rowKey: string | null = null;
  let rowTop = Number.POSITIVE_INFINITY;
  for (const element of viewport.querySelectorAll<HTMLElement>("[data-timeline-row-id]")) {
    const rect = element.getBoundingClientRect();
    if (rect.height === 0 || rect.bottom <= top || rect.top >= rowTop) continue;
    rowKey = element.dataset.timelineRowId ?? null;
    rowTop = rect.top;
  }
  const position = rowKey === null ? undefined : list.getState().positionByKey(rowKey);
  return position === undefined
    ? { rowKey: null, delta: 0, scrollTop: viewport.scrollTop }
    : { rowKey, delta: viewport.scrollTop - position, scrollTop: viewport.scrollTop };
}

function scrollHomeOffset(list: LegendListRef, home: ScrollHome): number {
  const position = home.rowKey === null ? undefined : list.getState().positionByKey(home.rowKey);
  return position === undefined ? home.scrollTop : position + home.delta;
}

/** Text the reader selected inside the timeline, if it fits a single-line query. */
export function threadFindSelectionText(viewport: HTMLElement | null): string | null {
  const selection = viewport?.ownerDocument.getSelection();
  if (!viewport || !selection || selection.isCollapsed) return null;
  if (!selection.anchorNode || !viewport.contains(selection.anchorNode)) return null;
  const text = selection.toString().trim();
  return text.length > 0 && text.length <= 200 && !text.includes("\n") ? text : null;
}

export type ThreadFindController = ReturnType<typeof useThreadFind>;

/**
 * Find in the open thread: local matches over loaded rows merged with the
 * server's, the selected match, and what the timeline needs to show it.
 */
export function useThreadFind(input: {
  readonly threadRef: ScopedThreadRef | null;
  /** False while the timeline paints a previous thread during a switch. */
  readonly enabled: boolean;
  readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly history: ThreadFindHistory | undefined;
  readonly listRef: RefObject<LegendListRef | null>;
}) {
  const { threadRef, enabled, items, entries, history, listRef } = input;
  const open = useThreadFindStore((state) => state.open);
  const query = useThreadFindStore((state) => state.query);
  const caseSensitive = useThreadFindStore((state) => state.caseSensitive);
  const wholeWord = useThreadFindStore((state) => state.wholeWord);
  const regex = useThreadFindStore((state) => state.regex);
  const scope = useThreadFindStore((state) => state.scope);
  const hit = useThreadFindStore((state) => state.hit);
  const clearHit = useThreadFindStore((state) => state.clearHit);
  const active = open && enabled && threadRef !== null;

  const findQuery = useMemo<ThreadFindQuery>(
    () => ({ query, caseSensitive, wholeWord, regex }),
    [query, caseSensitive, wholeWord, regex],
  );
  const entryIndex = useMemo(() => buildThreadFindEntryIndex(entries), [entries]);
  const isRendered = useCallback(
    (row: OrchestrationV2ProjectedTurnItem) => entryIndex.entryIdByItemId.has(row.sourceItemId),
    [entryIndex],
  );

  // Regex runs only over loaded rows: the server refuses it, since a
  // pathological pattern would stall it.
  const serverInput =
    active &&
    !regex &&
    query.length >= THREAD_FIND_SERVER_MIN_LENGTH &&
    compileThreadFind(findQuery)?._tag === "Valid"
      ? { threadId: threadRef.threadId, query, caseSensitive, wholeWord }
      : null;
  const serverSearches = serverInput !== null;
  const serverKey =
    serverInput === null ? null : JSON.stringify([threadRef?.environmentId, serverInput]);
  const debouncedServerKey = useDebouncedValue(serverKey, SERVER_DEBOUNCE_MS);
  const serverSettledInput = serverKey !== null && debouncedServerKey === serverKey;
  const server = useEnvironmentQuery(
    serverSettledInput && serverInput !== null && threadRef !== null
      ? orchestrationEnvironment.threadFind({
          environmentId: threadRef.environmentId,
          input: serverInput,
        })
      : null,
  );
  const serverData = serverSettledInput ? server.data : null;
  const serverFailed = serverSettledInput && server.error !== null;
  const serverPending = serverInput !== null && serverData === null && !serverFailed;

  // Re-run the server find when rows are added or finish, not per token.
  const contentRevision = useMemo(
    () => `${items.length}:${items.filter((row) => row.item.status === "completed").length}`,
    [items],
  );
  const refreshServer = server.refresh;
  const lastRevisionRef = useRef(contentRevision);
  useEffect(() => {
    if (lastRevisionRef.current === contentRevision) return;
    lastRevisionRef.current = contentRevision;
    if (serverData === null) return;
    const timer = window.setTimeout(refreshServer, SERVER_REFRESH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [contentRevision, refreshServer, serverData]);

  const derived = useMemo(
    () =>
      active
        ? deriveThreadFindResults({
            items,
            query: findQuery,
            scope,
            server: serverData,
            isRendered,
          })
        : NO_RESULTS,
    [active, findQuery, isRendered, items, scope, serverData],
  );
  // Streaming re-derives on every token; keep the previous results when
  // nothing changed so the list, ticks and painter are left alone.
  const [results, setResults] = useState(derived);
  if (results !== derived && !sameResults(results, derived)) setResults(derived);
  const matches = results.matches;
  // Cursor events read the latest matches; effects below run after this one.
  const matchesRef = useRef(matches);
  useLayoutEffect(() => {
    matchesRef.current = matches;
  }, [matches]);

  // Entries change on every streamed token; cursor callbacks read them here
  // so they keep their identity.
  const entryIndexRef = useRef(entryIndex);
  useLayoutEffect(() => {
    entryIndexRef.current = entryIndex;
  }, [entryIndex]);

  // Typing searches from where the reader is, by entry, so history prepended
  // later does not shift it. That is where find opened, the match the reader
  // stepped or picked to, or wherever they scrolled since. Find's own jumps do
  // not move it, or each keystroke would walk further down.
  const originEntryIdRef = useRef<string | null>(null);
  const readerScrolledRef = useRef(false);
  const captureOrigin = useCallback(() => {
    const viewport = listRef.current?.getScrollableNode() ?? null;
    originEntryIdRef.current =
      viewport === null ? null : readerEntryId(viewport, entryIndexRef.current.orderByEntryId);
    readerScrolledRef.current = false;
  }, [listRef]);
  useEffect(() => {
    const viewport = active ? listRef.current?.getScrollableNode() : null;
    if (!viewport) return;
    const scrolled = () => {
      readerScrolledRef.current = true;
    };
    const events = ["wheel", "touchmove", "pointerdown"] as const;
    for (const event of events) viewport.addEventListener(event, scrolled, { passive: true });
    return () => {
      for (const event of events) viewport.removeEventListener(event, scrolled);
    };
  }, [active, listRef]);
  // Where the reader was when find opened, for the way back.
  const homeRef = useRef<ScrollHome | null>(null);

  const nearest = useCallback(() => {
    const index = entryIndexRef.current;
    const originId = originEntryIdRef.current;
    const origin =
      (originId === null ? undefined : index.orderByEntryId.get(originId)) ??
      index.orderByEntryId.size - 1;
    return nearestThreadFindMatch(matchesRef.current, (match) =>
      isAtOrAboveOrigin(match, index, origin),
    );
  }, []);

  const [cursorState, setCursorState] = useState<CursorState>({
    cursor: THREAD_FIND_CURSOR_START,
    index: -1,
    match: null,
    requestId: 0,
  });
  const cursorRef = useRef(cursorState);
  const [wrapNoticeAt, setWrapNoticeAt] = useState<number | null>(null);
  const dispatch = useCallback(
    (event: ThreadFindCursorEvent) => {
      const previous = cursorRef.current;
      const next = reduceThreadFindCursor(previous.cursor, matchesRef.current, event, nearest);
      if (next.wrapped !== null) setWrapNoticeAt(Date.now());
      const navigates =
        event.type === "pick" || event.type === "step" || next.cursor.key !== previous.cursor.key;
      if (
        !navigates &&
        next.index === previous.index &&
        next.cursor.anchored === previous.cursor.anchored
      ) {
        return;
      }
      cursorRef.current = {
        cursor: next.cursor,
        index: next.index,
        match: navigates ? (matchesRef.current[next.index] ?? null) : previous.match,
        requestId: navigates ? previous.requestId + 1 : previous.requestId,
      };
      setCursorState(cursorRef.current);
    },
    [nearest],
  );

  const threadKey = threadRef === null ? null : scopedThreadKey(threadRef);
  const searchKey = active ? JSON.stringify([threadKey, findQuery]) : null;
  const lastSearchKeyRef = useRef<string | null>(null);
  const lastThreadKeyRef = useRef<string | null>(null);
  const lastServerDataRef = useRef(serverData);
  useEffect(() => {
    if (searchKey === null) {
      lastSearchKeyRef.current = null;
      lastThreadKeyRef.current = null;
      return;
    }
    if (lastThreadKeyRef.current !== threadKey) {
      lastThreadKeyRef.current = threadKey;
      homeRef.current = listRef.current === null ? null : captureScrollHome(listRef.current);
      captureOrigin();
    }
    const settled = serverData !== null && serverData !== lastServerDataRef.current;
    lastServerDataRef.current = serverData;
    if (lastSearchKeyRef.current !== searchKey) {
      lastSearchKeyRef.current = searchKey;
      const { cursor, match } = cursorRef.current;
      const matchEntryId =
        match?.loaded === true
          ? entryIndexRef.current.entryIdByItemId.get(match.sourceItemId)
          : undefined;
      if (readerScrolledRef.current) captureOrigin();
      else if (!cursor.anchored && matchEntryId !== undefined) {
        originEntryIdRef.current = matchEntryId;
      }
      dispatch({ type: "query" });
    } else {
      dispatch({ type: "results", settled });
    }
    // A thread search hit wins over the nearest match once it shows up. If
    // the server's answer lacks it too, find stays at the nearest match.
    if (hit === null || hit.threadKey !== threadKey) return;
    const index = matchesRef.current.findIndex((match) => match.messageId === hit.messageId);
    if (index >= 0) dispatch({ type: "pick", index });
    if (index >= 0 || serverData !== null || serverFailed || !serverSearches) clearHit();
  }, [
    captureOrigin,
    clearHit,
    dispatch,
    hit,
    listRef,
    matches,
    searchKey,
    serverData,
    serverFailed,
    serverSearches,
    threadKey,
  ]);

  // By key, so a match streamed in ahead of the cursor's does not point the
  // cursor elsewhere for a render before the cursor catches up.
  const currentIndex = useMemo(
    () =>
      cursorState.cursor.key === null
        ? -1
        : matches.findIndex((match) => match.key === cursorState.cursor.key),
    [cursorState.cursor.key, matches],
  );
  const current: ThreadFindMatch | null = currentIndex >= 0 ? matches[currentIndex]! : null;

  // A match in history the client has not loaded pages it in, one page at a
  // time, until its row arrives.
  const historyPagesRef = useRef({ key: null as string | null, pages: 0 });
  useEffect(() => {
    if (!active || current === null || current.loaded || history === undefined) return;
    if (historyPagesRef.current.key !== current.key) {
      historyPagesRef.current = { key: current.key, pages: 0 };
    }
    if (!history.hasMoreHistory || history.loading) return;
    if (historyPagesRef.current.pages >= MAX_HISTORY_PAGES) return;
    historyPagesRef.current.pages += 1;
    history.onLoadEarlier();
  }, [active, current, history]);

  // The cursor's match once its row is loaded. Until the cursor catches up
  // with new results, `current` may be another match, so the keys must agree.
  const currentEntryId =
    current !== null && current.key === cursorState.cursor.key && current.loaded
      ? (entryIndex.entryIdByItemId.get(current.sourceItemId) ?? null)
      : null;
  // Stable across streaming, so revealed rows do not re-render per token.
  const navigatedMatch = cursorState.match;
  const target = useMemo<ThreadFindTimelineTarget | null>(
    () =>
      currentEntryId === null || navigatedMatch === null
        ? null
        : { entryId: currentEntryId, match: navigatedMatch, requestId: cursorState.requestId },
    [currentEntryId, cursorState.requestId, navigatedMatch],
  );

  // Keyed by content, so streaming that adds no new entry repaints nothing.
  const paintKey = useMemo(() => {
    const ids = new Set<string>();
    for (const match of matches) {
      if (!match.loaded || match.field !== "text") continue;
      const entryId = entryIndex.entryIdByItemId.get(match.sourceItemId);
      if (entryId !== undefined) ids.add(entryId);
    }
    return [...ids].join("\n");
  }, [entryIndex, matches]);
  const paintEntryIds = useMemo<ReadonlySet<string>>(
    () => new Set(paintKey.length === 0 ? [] : paintKey.split("\n")),
    [paintKey],
  );
  const ticksKey = useMemo(
    () =>
      matches
        .flatMap((match) => {
          const entryId = match.loaded
            ? entryIndex.entryIdByItemId.get(match.sourceItemId)
            : undefined;
          return entryId === undefined ? [] : [`${match.key}\t${entryId}`];
        })
        .join("\n"),
    [entryIndex, matches],
  );
  const ticks = useMemo(
    () =>
      ticksKey.length === 0
        ? []
        : ticksKey.split("\n").map((line) => {
            const [key = "", entryId = ""] = line.split("\t");
            return { key, entryId };
          }),
    [ticksKey],
  );
  const hasUnloadedMatches = matches.some((match) => !match.loaded);
  // Matches group under the prompt that started their turn.
  const turnPrompts = useMemo(() => {
    const runByItemId = new Map<string, string>();
    const promptByRunId = new Map<string, string>();
    for (const row of items) {
      const runId = row.item.runId;
      if (runId === null) continue;
      runByItemId.set(row.sourceItemId, runId);
      if (row.item.type === "user_message" && !promptByRunId.has(runId)) {
        promptByRunId.set(runId, row.item.text.replace(/\s+/g, " ").trim());
      }
    }
    return { runByItemId, promptByRunId };
  }, [items]);
  const groupLabel = useCallback(
    (match: ThreadFindMatch) => {
      if (!match.loaded) return "Earlier in this thread, not loaded yet";
      const runId = turnPrompts.runByItemId.get(match.sourceItemId);
      const prompt = runId === undefined ? undefined : turnPrompts.promptByRunId.get(runId);
      return prompt === undefined || prompt.length === 0 ? "This thread" : prompt;
    },
    [turnPrompts],
  );
  const pickKey = useCallback(
    (key: string) => {
      const index = matchesRef.current.findIndex((match) => match.key === key);
      if (index >= 0) dispatch({ type: "pick", index });
    },
    [dispatch],
  );
  const timeline = useMemo<ThreadFindTimelineState | null>(
    () =>
      active && results.invalid === null && query.length > 0
        ? { query: findQuery, paintEntryIds, target, ticks, hasUnloadedMatches, onPick: pickKey }
        : null,
    [
      active,
      findQuery,
      hasUnloadedMatches,
      paintEntryIds,
      pickKey,
      query,
      results.invalid,
      target,
      ticks,
    ],
  );

  // After a long jump, closing offers the way back for a few seconds, in the
  // thread it was offered for.
  const [back, setBack] = useState<{
    readonly home: ScrollHome;
    readonly threadKey: string;
  } | null>(null);
  useEffect(() => {
    if (back === null) return;
    const timer = window.setTimeout(() => setBack(null), BACK_PILL_MS);
    return () => window.clearTimeout(timer);
  }, [back]);
  const closeFind = useThreadFindStore((state) => state.closeFind);
  const close = useCallback(() => {
    const list = listRef.current;
    const viewport = list?.getScrollableNode();
    const home = homeRef.current;
    if (
      list &&
      viewport &&
      home &&
      threadKey !== null &&
      Math.abs(viewport.scrollTop - scrollHomeOffset(list, home)) > viewport.clientHeight * 0.8
    ) {
      setBack({ home, threadKey });
    }
    closeFind();
  }, [closeFind, listRef, threadKey]);
  const goBack = useCallback(() => {
    const list = listRef.current;
    if (back !== null && list !== null) {
      void list.scrollToOffset({ offset: scrollHomeOffset(list, back.home), animated: false });
    }
    setBack(null);
  }, [back, listRef]);
  const step = useCallback(
    (direction: "older" | "newer") => dispatch({ type: "step", direction }),
    [dispatch],
  );
  const pick = useCallback((index: number) => dispatch({ type: "pick", index }), [dispatch]);
  const openFind = useThreadFindStore((state) => state.openFind);
  const reopen = useCallback(
    (prefill?: string) => {
      setBack(null);
      openFind(prefill);
    },
    [openFind],
  );

  return {
    isOpen: active,
    query: findQuery,
    scope,
    results,
    current,
    index: currentIndex,
    pending: serverPending,
    regexLocalOnly: regex && query.length > 0,
    wrapNoticeAt,
    groupLabel,
    timeline,
    showBack: back !== null && back.threadKey === threadKey,
    step,
    pick,
    openFind: reopen,
    close,
    goBack,
  };
}
