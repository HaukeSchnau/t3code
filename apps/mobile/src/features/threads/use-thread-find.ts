import { useAtomValue } from "@effect/atom-react";
import {
  deriveThreadFindResults,
  nearestThreadFindMatch,
  reduceThreadFindCursor,
  THREAD_FIND_CURSOR_START,
  THREAD_FIND_SERVER_MIN_LENGTH,
  threadFindItemKey,
  type ThreadFindCursor,
  type ThreadFindCursorEvent,
  type ThreadFindCursorState,
  type ThreadFindMatch,
  type ThreadFindResults,
} from "@t3tools/client-runtime/thread-find";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  compileThreadFind,
  findThreadMatches,
  type ThreadFindQuery,
} from "@t3tools/shared/threadFind";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useDebouncedValue } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { useThreadVisibleTurnItems } from "../../state/use-thread-detail";
import { threadFindSearchScope } from "./thread-find-feed";
import {
  threadFindColors,
  type ThreadFeedFind,
  type ThreadFindHighlighter,
} from "./thread-find-highlight";
import {
  clearThreadFindHit,
  threadFindHitAtom,
  threadFindPreferencesAtom,
} from "./thread-find-store";
import type { ThreadFeedHistoryControls } from "./ThreadFeed";

const SERVER_DEBOUNCE_MS = 200;
// The server's input schema caps queries here.
const SERVER_MAX_LENGTH = 200;
const HISTORY_PAGE_LIMIT = 20;
const WRAP_HINT_MS = 1_200;
// A one-letter query over a long message would otherwise split it into thousands of runs.
const RANGES_PER_TEXT = 500;

const EMPTY_RESULTS: ThreadFindResults = {
  matches: [],
  counts: { all: 0, user: 0, assistant: 0, tool: 0, reasoning: 0 },
  invalid: null,
  truncated: false,
};

/**
 * The server never runs regexes, since a pathological one would stall its event
 * loop, so regex find stays with the loaded timeline.
 */
export function threadFindServerInput(threadId: ThreadId, query: ThreadFindQuery) {
  if (
    query.regex ||
    query.query.length < THREAD_FIND_SERVER_MIN_LENGTH ||
    query.query.length > SERVER_MAX_LENGTH
  ) {
    return null;
  }
  return {
    threadId,
    query: query.query,
    ...(query.caseSensitive ? { caseSensitive: true } : {}),
    ...(query.wholeWord ? { wholeWord: true } : {}),
  };
}

interface CursorSession {
  readonly cursor: ThreadFindCursor;
  readonly wrapped: ThreadFindCursorState["wrapped"];
  readonly navigation: number;
}

type SessionEvent =
  | Exclude<ThreadFindCursorEvent, { readonly type: "pick" }>
  | { readonly type: "pick"; readonly key: string };

const START_SESSION: CursorSession = {
  cursor: THREAD_FIND_CURSOR_START,
  wrapped: null,
  navigation: 0,
};

/**
 * Streaming rewrites a text match's excerpt on every token. Rows read text
 * excerpts from their own item, so only a detail excerpt, which comes from the
 * server, makes a new match.
 */
function sameMatch(left: ThreadFindMatch | null, right: ThreadFindMatch | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.key === right.key &&
      left.loaded === right.loaded &&
      (left.field === "text" ||
        (left.excerpt.text === right.excerpt.text && left.excerpt.start === right.excerpt.start)))
  );
}

function sameKeys(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((key) => right.has(key));
}

/** Keeps the previous value while `same` holds, so streaming does not re-render matched rows. */
function useStable<A>(value: A, same: (left: A, right: A) => boolean): A {
  const ref = useRef(value);
  if (!same(ref.current, value)) ref.current = value;
  return ref.current;
}

export function useThreadFindSession(input: {
  readonly active: boolean;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly feed: ReadonlyArray<ThreadFeedEntry>;
  readonly history: ThreadFeedHistoryControls | undefined;
  /** The item at the bottom of the reader's viewport; null means the end. */
  readonly readAnchor: () => string | null;
  /** Set when the reader drags the feed, so the next query reads the anchor again. */
  readonly readerScrolledRef: { current: boolean };
  readonly appearance: "light" | "dark";
}) {
  const preferences = useAtomValue(threadFindPreferencesAtom);
  const deferred = useDeferredValue(preferences);
  const visibleItems = useThreadVisibleTurnItems({
    environmentId: input.environmentId,
    threadId: input.threadId,
  });
  const query = useMemo(
    () => ({
      query: deferred.query,
      caseSensitive: deferred.caseSensitive,
      wholeWord: deferred.wholeWord,
      regex: deferred.regex,
    }),
    [deferred.query, deferred.caseSensitive, deferred.wholeWord, deferred.regex],
  );
  const matcher = useMemo(() => compileThreadFind(query), [query]);
  const serverEligible =
    input.active &&
    matcher?._tag === "Valid" &&
    threadFindServerInput(input.threadId, query) !== null;
  const debouncedQuery = useDebouncedValue(query, SERVER_DEBOUNCE_MS);
  const serverInput =
    serverEligible && debouncedQuery === query
      ? threadFindServerInput(input.threadId, query)
      : null;
  const server = useEnvironmentQuery(
    serverInput === null
      ? null
      : orchestrationEnvironment.threadFind({
          environmentId: input.environmentId,
          input: serverInput,
        }),
  );
  const serverData = serverInput === null ? null : server.data;
  const pending = serverEligible && (serverInput === null || server.isPending);
  // A failed request counts as the server's answer, so nothing waits on it.
  const answered =
    serverInput !== null && !server.isPending && (serverData !== null || server.error !== null);

  const scope = useMemo(
    () =>
      input.active
        ? threadFindSearchScope({ items: visibleItems, feed: input.feed, server: serverData })
        : null,
    [input.active, input.feed, serverData, visibleItems],
  );
  const results = useMemo(
    () =>
      scope === null
        ? EMPTY_RESULTS
        : deriveThreadFindResults({
            items: scope.items,
            query,
            scope: deferred.scope,
            server: scope.server,
          }),
    [deferred.scope, query, scope],
  );
  const items = useMemo(
    () =>
      new Map(
        scope?.items.map(
          (row) => [threadFindItemKey(row.sourceThreadId, row.sourceItemId), row] as const,
        ),
      ),
    [scope],
  );
  const timelineIndex = useMemo(
    () => new Map([...items.keys()].map((itemKey, index) => [itemKey, index] as const)),
    [items],
  );
  // Where the reader was when find opened or the query last changed.
  const anchor = useRef<string | null>(null);
  const nearest = useCallback(() => {
    const position = (itemKey: string | null) =>
      (itemKey === null ? undefined : timelineIndex.get(itemKey)) ?? Number.POSITIVE_INFINITY;
    const anchorPosition = position(anchor.current);
    return nearestThreadFindMatch(
      results.matches,
      (match) => position(match.itemKey) <= anchorPosition,
    );
  }, [results.matches, timelineIndex]);

  const [session, setSession] = useState(START_SESSION);
  const live = useRef({ matches: results.matches, nearest, cursor: session.cursor });
  live.current = { matches: results.matches, nearest, cursor: session.cursor };
  const dispatch = useCallback(
    (event: SessionEvent, navigates: boolean) =>
      setSession((current) => {
        const { matches } = live.current;
        // A pick names its match, so results that land between render and tap cannot shift it.
        const cursorEvent: ThreadFindCursorEvent =
          event.type === "pick"
            ? { type: "pick", index: matches.findIndex((match) => match.key === event.key) }
            : event;
        if (cursorEvent.type === "pick" && cursorEvent.index < 0) return current;
        const next = reduceThreadFindCursor(
          current.cursor,
          matches,
          cursorEvent,
          live.current.nearest,
        );
        if (
          !navigates &&
          next.cursor.key === current.cursor.key &&
          next.cursor.anchored === current.cursor.anchored
        ) {
          return current;
        }
        return {
          cursor: next.cursor,
          wrapped: navigates ? next.wrapped : current.wrapped,
          navigation: navigates ? current.navigation + 1 : current.navigation,
        };
      }),
    [],
  );

  // Typing searches from the reader's place: where find opened, the match they
  // stepped or picked to, or wherever they dragged since. Find's own scrolls do
  // not move it, or each keystroke would walk further down. A new answer from
  // the server may move an untouched selection; results alone never do.
  const sessionKey = input.active
    ? JSON.stringify([input.environmentId, input.threadId, query])
    : null;
  const settledKey = answered ? JSON.stringify(serverInput) : null;
  const { readAnchor, readerScrolledRef } = input;
  const seen = useRef({
    sessionKey: null as string | null,
    matches: results.matches,
    settledKey: null as string | null,
  });
  useLayoutEffect(() => {
    const previous = seen.current;
    seen.current = { sessionKey, matches: results.matches, settledKey };
    if (sessionKey === null) return;
    if (previous.sessionKey !== sessionKey) {
      const { cursor } = live.current;
      const stepped = cursor.anchored
        ? undefined
        : previous.matches.find((match) => match.key === cursor.key);
      if (previous.sessionKey === null || readerScrolledRef.current) {
        anchor.current = readAnchor();
        readerScrolledRef.current = false;
      } else if (stepped !== undefined) {
        anchor.current = stepped.itemKey;
      }
      dispatch({ type: "query" }, false);
    } else if (previous.matches !== results.matches) {
      dispatch(
        { type: "results", settled: settledKey !== null && settledKey !== previous.settledKey },
        false,
      );
    }
  }, [dispatch, readAnchor, readerScrolledRef, results.matches, sessionKey, settledKey]);

  // A thread search hit wins over the nearest match once it shows up. If the
  // server's answer lacks it too, find stays at the nearest match.
  const hit = useAtomValue(threadFindHitAtom);
  useEffect(() => {
    if (!input.active || hit === null || hit.query !== query.query) return;
    if (hit.environmentId !== input.environmentId || hit.threadId !== input.threadId) return;
    const match = results.matches.find((candidate) => candidate.messageId === hit.messageId);
    if (match !== undefined) dispatch({ type: "pick", key: match.key }, true);
    if (match !== undefined || settledKey !== null || !serverEligible) clearThreadFindHit();
  }, [
    dispatch,
    hit,
    input.active,
    input.environmentId,
    input.threadId,
    query.query,
    results.matches,
    serverEligible,
    settledKey,
  ]);

  useEffect(() => {
    if (session.wrapped === null) return;
    const timer = setTimeout(
      () => setSession((current) => ({ ...current, wrapped: null })),
      WRAP_HINT_MS,
    );
    return () => clearTimeout(timer);
  }, [session.wrapped, session.navigation]);

  const index =
    session.cursor.key === null
      ? -1
      : results.matches.findIndex((match) => match.key === session.cursor.key);
  const current = useStable(results.matches[index] ?? null, sameMatch);

  // A match in history the client has not loaded pulls in earlier pages until it arrives.
  const history = input.history;
  const loadedPages = useRef({ key: null as string | null, pages: 0 });
  useEffect(() => {
    if (!input.active || current === null || current.loaded) return;
    if (!history?.hasMoreHistory || history.loading) return;
    if (loadedPages.current.key !== current.key)
      loadedPages.current = { key: current.key, pages: 0 };
    if (loadedPages.current.pages >= HISTORY_PAGE_LIMIT) return;
    loadedPages.current.pages += 1;
    history.onLoadEarlier();
  }, [current, history, input.active]);

  const colors = threadFindColors(input.appearance);
  const highlighter = useMemo<ThreadFindHighlighter | null>(
    () =>
      matcher?._tag === "Valid"
        ? {
            find: (text) => findThreadMatches(matcher, text, RANGES_PER_TEXT),
            color: colors.color,
            currentColor: colors.currentColor,
          }
        : null,
    [colors.color, colors.currentColor, matcher],
  );
  const matchedItemKeys = useStable(
    useMemo(() => new Set(results.matches.map((match) => match.itemKey)), [results.matches]),
    sameKeys,
  );
  const feedFind = useMemo<ThreadFeedFind | null>(
    () =>
      input.active && highlighter !== null
        ? { highlighter, matchedItemKeys, current, navigation: session.navigation }
        : null,
    [current, highlighter, input.active, matchedItemKeys, session.navigation],
  );

  return {
    preferences,
    results,
    index,
    current,
    pending,
    /** Regex find never reaches the server, so it only covers loaded history. */
    loadedOnly: query.regex,
    wrapped: session.wrapped,
    items,
    highlighter,
    feedFind,
    step: useCallback(
      (direction: "older" | "newer") => dispatch({ type: "step", direction }, true),
      [dispatch],
    ),
    pick: useCallback((key: string) => dispatch({ type: "pick", key }, true), [dispatch]),
  };
}

export type ThreadFindSession = ReturnType<typeof useThreadFindSession>;
