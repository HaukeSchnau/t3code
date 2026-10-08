import {
  MessageId,
  PlanId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationThreadFindMatch,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { deriveThreadFindResults } from "@t3tools/client-runtime/thread-find";
import { compileThreadFind, findThreadMatches } from "@t3tools/shared/threadFind";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadFeed, deriveThreadFeedPresentation } from "../../lib/threadActivity";
import {
  resolveThreadFindReveal,
  threadFindAnchorItemKey,
  threadFindRowExcerpt,
  threadFindSearchScope,
  threadFindSnippet,
} from "./thread-find-feed";

const threadId = ThreadId.make("thread");
const runId = RunId.make("run");

function base(id: string, ordinal: number) {
  const at = DateTime.makeUnsafe(Date.UTC(2026, 9, 8, 10, 0, ordinal));
  return {
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
}

const user = (id: string, ordinal: number, text: string): OrchestrationV2TurnItem => ({
  ...base(id, ordinal),
  runId: null,
  type: "user_message",
  messageId: MessageId.make(id),
  createdBy: "user",
  creationSource: "mobile",
  inputIntent: "turn_start",
  text,
  attachments: [],
});
const assistant = (id: string, ordinal: number, text: string): OrchestrationV2TurnItem => ({
  ...base(id, ordinal),
  type: "assistant_message",
  messageId: MessageId.make(id),
  text,
  streaming: false,
});
const command = (id: string, ordinal: number, input: string): OrchestrationV2TurnItem => ({
  ...base(id, ordinal),
  type: "command_execution",
  input,
  output: "",
  exitCode: 0,
});

const projected = (items: ReadonlyArray<OrchestrationV2TurnItem>) =>
  items.map((item, position): OrchestrationV2ProjectedTurnItem => ({
    position,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: item.id,
    item,
  }));

// A settled run folds the work between its first and last answer.
const turn = projected([
  user("ask", 0, "Run the probe"),
  assistant("plan", 1, "Starting the probe."),
  command("probe", 2, "vp test run probe.test.ts"),
  assistant("answer", 3, "The probe passed."),
]);
const feed = buildThreadFeed(turn);

describe("resolveThreadFindReveal", () => {
  const reveal = (itemId: string) =>
    resolveThreadFindReveal({
      feed,
      latestRun: null,
      activeWorkStartedAt: null,
      runlessWorkActive: false,
      expandedRunIds: new Set(),
      expandedWorkGroupIds: new Set(),
      itemKey: `${threadId}:${itemId}`,
    });

  it("opens the run fold and the work group that hide a tool call", () => {
    const target = reveal("probe");
    expect(target).toEqual({
      rowId: "work-details:work-group:local:thread:probe",
      runId,
      workGroupId: "work-group:local:thread:probe",
    });
    const shown = deriveThreadFeedPresentation(
      feed,
      null,
      new Set([runId]),
      new Set([target!.workGroupId!]),
    );
    expect(shown.some((row) => row.id === target!.rowId)).toBe(true);
  });

  it("opens nothing for a row that is already on screen", () => {
    expect(reveal("answer")).toEqual({ rowId: "answer", runId: null, workGroupId: null });
  });
});

describe("threadFindSearchScope", () => {
  const todo: OrchestrationV2TurnItem = {
    ...base("todo", 4),
    type: "todo_list",
    planId: PlanId.make("plan"),
    explanation: "probe plan",
    steps: [],
  };
  const serverMatch = (itemId: string): OrchestrationThreadFindMatch => ({
    sourceThreadId: threadId,
    sourceItemId: TurnItemId.make(itemId),
    position: 0,
    source: "tool",
    field: "text",
    occurrence: 0,
    excerpt: { text: "probe", start: 0, end: 5, line: 1 },
  });

  it("drops rows the feed hides, so their matches never read as unloaded history", () => {
    const items = projected([...turn.map((row) => row.item), todo]);
    const scope = threadFindSearchScope({
      items,
      feed: buildThreadFeed(items),
      server: { truncated: false, matches: [serverMatch("todo"), serverMatch("older")] },
    });
    expect(scope.items.map((row) => row.sourceItemId)).toEqual(["ask", "plan", "probe", "answer"]);
    expect(scope.server?.matches.map((match) => match.sourceItemId)).toEqual(["older"]);
  });
});

describe("threadFindAnchorItemKey", () => {
  it("takes the last item shown at or above the viewport bottom", () => {
    const rows = deriveThreadFeedPresentation(feed, null, new Set());
    const foldIndex = rows.findIndex((row) => row.type === "run-fold");
    expect(threadFindAnchorItemKey(rows, foldIndex)).toBe(`${threadId}:plan`);
    expect(threadFindAnchorItemKey(rows, rows.length + 4)).toBe(`${threadId}:answer`);
    expect(threadFindAnchorItemKey([], 0)).toBeNull();
  });
});

describe("threadFindSnippet", () => {
  it("keeps the match's own line and trims a long lead-in", () => {
    const text = "first line\n    a very long lead-in before the probe word here\nlast";
    const start = text.indexOf("probe");
    expect(threadFindSnippet({ text, start, end: start + 5, line: 2 }, 12)).toEqual({
      before: "…before the ",
      match: "probe",
      after: " word here",
    });
  });
});

describe("threadFindRowExcerpt", () => {
  const query = { query: "probe" };
  const matcher = compileThreadFind(query);
  const find = (text: string) =>
    matcher?._tag === "Valid" ? findThreadMatches(matcher, text, 500) : [];
  const reasoning = (text: string): OrchestrationV2TurnItem => ({
    ...base("thinking", 1),
    type: "reasoning",
    text,
    streaming: true,
  });

  it("reads a text excerpt from the row's latest item, not from the match", () => {
    const before = reasoning("one probe, then a probe");
    const [, second] = deriveThreadFindResults({
      items: projected([before]),
      query,
      scope: "all",
      server: null,
    }).matches;
    const text = "one probe, then a probe that keeps going";
    expect(threadFindRowExcerpt(second!, reasoning(text), find)).toMatchObject({
      text,
      start: text.lastIndexOf("probe"),
    });
  });

  it("keeps a detail excerpt, which only the server has", () => {
    const excerpt = { text: "probe output", start: 0, end: 5, line: 3 };
    const [match] = deriveThreadFindResults({
      items: projected([command("cmd", 1, "ls")]),
      query,
      scope: "all",
      server: {
        matches: [
          {
            sourceThreadId: threadId,
            sourceItemId: TurnItemId.make("cmd"),
            position: 0,
            source: "tool",
            field: "detail",
            occurrence: 0,
            excerpt,
          } satisfies OrchestrationThreadFindMatch,
        ],
        truncated: false,
      },
    }).matches;
    expect(threadFindRowExcerpt(match!, command("cmd", 1, "ls"), find)).toBe(excerpt);
  });
});
