import type {
  EnvironmentId,
  OrchestrationV2SearchThreadResult,
  ThreadId,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import type { SelectableMarkdownSkill } from "../../native/SelectableMarkdownText.types";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useDebouncedValue } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import type { ThreadFindStart } from "./thread-find-feed";

export type ThreadFindMatch = NonNullable<OrchestrationV2SearchThreadResult["match"]>;

/** What the feed needs to reveal the current match and mark plain text. */
export interface ThreadFeedFind {
  readonly query: string;
  readonly match: ThreadFindMatch;
  /** Bumped by every query edit and step, so the feed moves even when the match stays put. */
  readonly navigation: number;
}

const QUERY_DEBOUNCE_MS = 150;
// Streaming changes the counts on every token, so a refresh waits for the content to settle.
const CONTENT_REFRESH_MS = 300;

interface FindState {
  readonly threadKey: string;
  readonly query: string;
  /** Where the server counts from: the reader's place, or the match a step leaves. */
  readonly start: ThreadFindStart | undefined;
  readonly offset: number;
  readonly navigation: number;
}

interface FindAnswer {
  readonly key: string;
  readonly navigation: number;
  readonly result: OrchestrationV2SearchThreadResult;
}

const closedFind = (threadKey: string): FindState => ({
  threadKey,
  query: "",
  start: undefined,
  offset: 0,
  navigation: 0,
});

/**
 * Find in thread on the server's `searchThread`, which counts matches in user
 * messages, assistant messages and plans the way the web find does.
 */
export function useThreadFind(input: {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly skills: ReadonlyArray<SelectableMarkdownSkill> | undefined;
  /** Changes with the thread's content, which makes the counts stale. */
  readonly content: unknown;
  /** The first searchable entry the reader can see. */
  readonly readStart: () => ThreadFindStart | undefined;
}) {
  const threadKey = `${input.environmentId}:${input.threadId}`;
  const [storedState, setState] = useState(() => closedFind(threadKey));
  let state = storedState;
  if (state.threadKey !== threadKey) {
    state = closedFind(threadKey);
    setState(state);
  }

  const query = state.query.trim();
  const debouncedQuery = useDebouncedValue(query, QUERY_DEBOUNCE_MS);
  const skills = (input.skills ?? []).map(({ name, displayName }) =>
    displayName ? { name, displayName } : { name },
  );
  const request =
    input.open && query.length > 0 && debouncedQuery === query
      ? {
          environmentId: input.environmentId,
          input: {
            threadId: input.threadId,
            query,
            ...(state.start ? { start: state.start } : {}),
            ...(state.offset !== 0 ? { offset: state.offset } : {}),
            ...(skills.length > 0 ? { skills } : {}),
          },
        }
      : null;
  const remote = useEnvironmentQuery(
    request === null ? null : orchestrationEnvironment.threadFind(request),
  );

  // A new request has no data until it answers, so the bar keeps the last answer for this query.
  const answerKey = `${threadKey}\u0000${query}`;
  const [answer, setAnswer] = useState<FindAnswer | null>(null);
  if (
    request !== null &&
    remote.data !== null &&
    !remote.isPending &&
    (answer?.result !== remote.data || answer.navigation !== state.navigation)
  ) {
    setAnswer({ key: answerKey, navigation: state.navigation, result: remote.data });
  }
  const data = answer?.key === answerKey ? answer.result : null;
  const settled = data !== null && answer?.navigation === state.navigation;
  const match = data?.match ?? null;

  const setQuery = (text: string) => {
    const start = input.readStart();
    setState((previous) => ({
      ...previous,
      query: text,
      start,
      offset: 0,
      navigation: previous.navigation + 1,
    }));
  };

  const step = (delta: 1 | -1) => {
    if (data === null || data.totalMatches === 0) return;
    const leaving = settled && match !== null ? match : null;
    setState((previous) =>
      // Taps that land before the answer add up instead of each restarting from the old match.
      previous.navigation === state.navigation && leaving !== null
        ? {
            ...previous,
            start: { entryId: leaving.entryId, occurrence: leaving.occurrence },
            offset: delta,
            navigation: previous.navigation + 1,
          }
        : { ...previous, offset: previous.offset + delta, navigation: previous.navigation + 1 },
    );
  };

  // Reopening searches again from where the reader is now.
  const { readStart } = input;
  const wasOpen = useRef(input.open);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the reader's place lives in the native list, readable only once find has opened
  useEffect(() => {
    const opened = input.open && !wasOpen.current;
    wasOpen.current = input.open;
    if (!opened) return;
    const start = readStart();
    setState((previous) =>
      previous.query.trim().length === 0
        ? previous
        : { ...previous, start, offset: 0, navigation: previous.navigation + 1 },
    );
  }, [input.open, readStart]);

  // New content recounts from the current match without moving the reader.
  const refreshCounts = useEffectEvent(() => {
    if (!settled || match === null) return;
    if (
      state.offset === 0 &&
      state.start?.entryId === match.entryId &&
      state.start.occurrence === match.occurrence
    ) {
      remote.refresh();
      return;
    }
    setState((previous) => ({
      ...previous,
      start: { entryId: match.entryId, occurrence: match.occurrence },
      offset: 0,
    }));
  });
  const lastContent = useRef(input.content);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- recounts once streamed content settles, on a timer the next change cancels
  useEffect(() => {
    if (lastContent.current === input.content) return;
    lastContent.current = input.content;
    if (!input.open || query.length === 0) return;
    const timer = setTimeout(() => refreshCounts(), CONTENT_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [input.content, input.open, query]);

  const searching = query.length > 0 && data === null && remote.error === null;
  return {
    query: state.query,
    setQuery,
    matchCount: data?.totalMatches ?? 0,
    activeIndex: data?.activeIndex ?? 0,
    status: remote.error !== null ? ("error" as const) : searching ? ("searching" as const) : null,
    retry: remote.refresh,
    next: () => step(1),
    previous: () => step(-1),
    feedFind:
      input.open && match !== null && answer !== null
        ? ({ query, match, navigation: answer.navigation } satisfies ThreadFeedFind)
        : null,
  };
}

export type ThreadFindSession = ReturnType<typeof useThreadFind>;
