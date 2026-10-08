import {
  MessageId,
  ThreadId,
  TurnItemId,
  type OrchestrationThreadFindMatch,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveThreadFindResults,
  nearestThreadFindMatch,
  reduceThreadFindCursor,
  THREAD_FIND_CURSOR_START,
  type ThreadFindMatch,
} from "./threadFind.ts";

const threadId = ThreadId.make("thread");
const at = DateTime.makeUnsafe(Date.UTC(2026, 9, 8));

function row(id: string, item: Record<string, unknown>): OrchestrationV2ProjectedTurnItem {
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: TurnItemId.make(id),
    item: {
      id: TurnItemId.make(id),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
      ...item,
    } as OrchestrationV2ProjectedTurnItem["item"],
  };
}

const assistant = (id: string, text: string) =>
  row(id, { type: "assistant_message", messageId: MessageId.make(id), text, streaming: false });
const command = (id: string, input: string) => row(id, { type: "command_execution", input });

function serverMatch(
  id: string,
  field: "text" | "detail",
  occurrence: number,
  source: OrchestrationThreadFindMatch["source"] = "tool",
): OrchestrationThreadFindMatch {
  return {
    sourceThreadId: threadId,
    sourceItemId: TurnItemId.make(id),
    position: 0,
    source,
    field,
    occurrence,
    excerpt: { text: "probe", start: 0, end: 5, line: 1 },
  };
}

describe("deriveThreadFindResults", () => {
  const items = [
    command("cmd", "vp test run probe.test.ts"),
    assistant("answer", "The `probe` waits."),
  ];

  it("puts history the client lacks first and adds server detail to loaded rows", () => {
    const results = deriveThreadFindResults({
      items,
      query: { query: "probe" },
      scope: "all",
      server: {
        truncated: false,
        matches: [
          serverMatch("old", "text", 0, "user"),
          serverMatch("cmd", "text", 0),
          serverMatch("cmd", "detail", 0),
          serverMatch("cmd", "detail", 1),
          serverMatch("answer", "text", 0, "assistant"),
        ],
      },
    });
    expect(results.matches.map((match) => [match.key, match.loaded])).toEqual([
      ["thread:old:text:0", false],
      ["thread:cmd:text:0", true],
      ["thread:cmd:detail:0", true],
      ["thread:cmd:detail:1", true],
      ["thread:answer:text:0", true],
    ]);
    expect(results.counts).toEqual({ all: 5, user: 1, assistant: 1, tool: 3, reasoning: 0 });
  });

  it("matches locally before the server answers and filters by scope", () => {
    const local = deriveThreadFindResults({
      items,
      query: { query: "probe" },
      scope: "all",
      server: null,
    });
    expect(local.matches.map((match) => match.key)).toEqual([
      "thread:cmd:text:0",
      "thread:answer:text:0",
    ]);
    expect(local.matches[1]!.excerpt.text).toBe("The probe waits.");
    expect(local.matches.map((match) => match.messageId)).toEqual([undefined, "answer"]);

    const scoped = deriveThreadFindResults({
      items,
      query: { query: "probe" },
      scope: "assistant",
      server: null,
    });
    expect(scoped.matches.map((match) => match.key)).toEqual(["thread:answer:text:0"]);
    expect(scoped.counts.all).toBe(2);
  });

  it("skips rows the client does not show, without treating them as unloaded", () => {
    const results = deriveThreadFindResults({
      items,
      query: { query: "probe" },
      scope: "all",
      server: { truncated: false, matches: [serverMatch("cmd", "detail", 0)] },
      isRendered: (row) => row.sourceItemId !== "cmd",
    });
    expect(results.matches.map((match) => match.key)).toEqual(["thread:answer:text:0"]);
  });

  it("reports an invalid regex instead of matching", () => {
    const results = deriveThreadFindResults({
      items,
      query: { query: "probe(", regex: true },
      scope: "all",
      server: null,
    });
    expect(results.matches).toEqual([]);
    expect(results.invalid).not.toBeNull();
  });
});

const match = (key: string, loaded = true) => ({ key, loaded }) as ThreadFindMatch;

describe("nearestThreadFindMatch", () => {
  it("takes the last match at or above the viewport bottom", () => {
    const matches = [match("a"), match("b"), match("c")];
    expect(nearestThreadFindMatch(matches, (m) => m.key !== "c")).toBe(1);
    expect(nearestThreadFindMatch(matches, () => false)).toBe(0);
    expect(nearestThreadFindMatch([], () => true)).toBe(-1);
  });

  it("treats unloaded history as above everything loaded", () => {
    const matches = [match("old", false), match("a"), match("b")];
    expect(nearestThreadFindMatch(matches, () => false)).toBe(0);
  });
});

describe("reduceThreadFindCursor", () => {
  const matches = [match("a"), match("b"), match("c")];

  it("follows the nearest match until the reader picks one", () => {
    const typed = reduceThreadFindCursor(
      THREAD_FIND_CURSOR_START,
      matches,
      { type: "query" },
      () => 1,
    );
    expect(typed).toMatchObject({ index: 1, cursor: { key: "b", anchored: true } });

    const settled = reduceThreadFindCursor(
      typed.cursor,
      matches,
      { type: "results", settled: true },
      () => 2,
    );
    expect(settled.index).toBe(2);

    const picked = reduceThreadFindCursor(
      settled.cursor,
      matches,
      { type: "pick", index: 0 },
      () => 2,
    );
    const late = reduceThreadFindCursor(
      picked.cursor,
      matches,
      { type: "results", settled: true },
      () => 2,
    );
    expect(late).toMatchObject({ index: 0, cursor: { key: "a", anchored: false } });
  });

  it("keeps its match when results change and re-anchors when it disappears", () => {
    const cursor = { key: "b", anchored: false };
    const streamed = [match("a"), match("b"), match("c"), match("d")];
    expect(
      reduceThreadFindCursor(cursor, streamed, { type: "results", settled: false }, () => 3).index,
    ).toBe(1);
    expect(
      reduceThreadFindCursor(cursor, [match("a")], { type: "results", settled: false }, () => 0)
        .index,
    ).toBe(0);
  });

  it("wraps when stepping past either end", () => {
    const first = { key: "a", anchored: false };
    expect(
      reduceThreadFindCursor(first, matches, { type: "step", direction: "older" }, () => 0),
    ).toMatchObject({
      index: 2,
      wrapped: "to-newest",
    });
    const last = { key: "c", anchored: false };
    expect(
      reduceThreadFindCursor(last, matches, { type: "step", direction: "newer" }, () => 0),
    ).toMatchObject({
      index: 0,
      wrapped: "to-oldest",
    });
    expect(
      reduceThreadFindCursor(
        THREAD_FIND_CURSOR_START,
        matches,
        { type: "step", direction: "older" },
        () => 0,
      ).index,
    ).toBe(2);
  });
});
