import type { LegendListRef } from "@legendapp/list/react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  deriveThreadFindResults,
  nearestThreadFindMatch,
  reduceThreadFindCursor,
  THREAD_FIND_CURSOR_START,
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
  const serverPending = serverInput !== null && serverData === null && server.error === null;

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

  const results: ThreadFindResults = useMemo(
    () =>
      active
        ? deriveThreadFindResults({
            items,
            query: findQuery,
            scope,
            server: serverData,
            isRendered,
          })
        : {
            matches: [],
            counts: { all: 0, user: 0, assistant: 0, tool: 0, reasoning: 0 },
            invalid: null,
            truncated: false,
          },
    [active, findQuery, isRendered, items, scope, serverData],
  );
  const matches = results.matches;
  // Cursor events read the latest matches; effects below run after this one.
  const matchesRef = useRef(matches);
  useLayoutEffect(() => {
    matchesRef.current = matches;
  }, [matches]);

  // Where the reader was when find opened or the thread changed.
  const originRef = useRef<{ readonly order: number; readonly scrollTop: number } | null>(null);
  const captureOrigin = useCallback(() => {
    const viewport = listRef.current?.getScrollableNode() ?? null;
    let order = -1;
    if (viewport) {
      const bottom = viewport.getBoundingClientRect().bottom;
      for (const element of viewport.querySelectorAll<HTMLElement>("[data-find-entry]")) {
        const rect = element.getBoundingClientRect();
        if (rect.height === 0 || rect.top >= bottom) continue;
        const entryOrder = entryIndex.orderByEntryId.get(element.dataset.findEntry ?? "");
        if (entryOrder !== undefined && entryOrder > order) order = entryOrder;
      }
    }
    originRef.current = {
      order: order === -1 ? entries.length - 1 : order,
      scrollTop: viewport?.scrollTop ?? 0,
    };
  }, [entries.length, entryIndex, listRef]);

  const nearest = useCallback(() => {
    const origin = originRef.current?.order ?? entries.length - 1;
    return nearestThreadFindMatch(matchesRef.current, (match) =>
      isAtOrAboveOrigin(match, entryIndex, origin),
    );
  }, [entries.length, entryIndex]);

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
      captureOrigin();
    }
    const settled = serverData !== null && serverData !== lastServerDataRef.current;
    lastServerDataRef.current = serverData;
    if (lastSearchKeyRef.current !== searchKey) {
      lastSearchKeyRef.current = searchKey;
      dispatch({ type: "query" });
    } else {
      dispatch({ type: "results", settled });
    }
    // A thread search hit wins over the nearest match once it shows up. If
    // the server's answer lacks it too, find stays at the nearest match.
    if (hit === null || hit.threadKey !== threadKey) return;
    const index = matchesRef.current.findIndex((match) => match.messageId === hit.messageId);
    if (index >= 0) dispatch({ type: "pick", index });
    if (index >= 0 || serverData !== null || !serverSearches) clearHit();
  }, [
    captureOrigin,
    clearHit,
    dispatch,
    hit,
    matches,
    searchKey,
    serverData,
    serverSearches,
    threadKey,
  ]);

  const current: ThreadFindMatch | null =
    cursorState.index >= 0 ? (matches[cursorState.index] ?? null) : null;

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
  const ticks = useMemo(
    () =>
      matches.flatMap((match) => {
        const entryId = match.loaded
          ? entryIndex.entryIdByItemId.get(match.sourceItemId)
          : undefined;
        return entryId === undefined ? [] : [{ key: match.key, entryId }];
      }),
    [entryIndex, matches],
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

  // After a long jump, closing offers the way back for a few seconds.
  const [backOffset, setBackOffset] = useState<number | null>(null);
  useEffect(() => {
    if (backOffset === null) return;
    const timer = window.setTimeout(() => setBackOffset(null), BACK_PILL_MS);
    return () => window.clearTimeout(timer);
  }, [backOffset]);
  const closeFind = useThreadFindStore((state) => state.closeFind);
  const close = useCallback(() => {
    const viewport = listRef.current?.getScrollableNode();
    const origin = originRef.current;
    if (
      viewport &&
      origin &&
      Math.abs(viewport.scrollTop - origin.scrollTop) > viewport.clientHeight * 0.8
    ) {
      setBackOffset(origin.scrollTop);
    }
    closeFind();
  }, [closeFind, listRef]);
  const goBack = useCallback(() => {
    if (backOffset !== null)
      void listRef.current?.scrollToOffset({ offset: backOffset, animated: false });
    setBackOffset(null);
  }, [backOffset, listRef]);
  const step = useCallback(
    (direction: "older" | "newer") => dispatch({ type: "step", direction }),
    [dispatch],
  );
  const pick = useCallback((index: number) => dispatch({ type: "pick", index }), [dispatch]);
  const openFind = useThreadFindStore((state) => state.openFind);
  const reopen = useCallback(
    (prefill?: string) => {
      setBackOffset(null);
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
    index: cursorState.index,
    pending: serverPending,
    regexLocalOnly: regex && query.length > 0,
    wrapNoticeAt,
    groupLabel,
    timeline,
    showBack: backOffset !== null,
    step,
    pick,
    openFind: reopen,
    close,
    goBack,
  };
}
