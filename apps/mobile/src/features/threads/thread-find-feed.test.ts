import {
  MessageId,
  PlanId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadFeed, deriveThreadFeedPresentation } from "../../lib/threadActivity";
import {
  resolveThreadFindReveal,
  threadFeedHoldsFindEntry,
  threadFindStartInRows,
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

const proposal = (id: string, ordinal: number, markdown: string): OrchestrationV2TurnItem => ({
  ...base(id, ordinal),
  type: "proposed_plan",
  planId: PlanId.make(id),
  markdown,
  streaming: false,
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
const feed = buildThreadFeed(
  projected([
    user("ask", 0, "Run the probe"),
    assistant("plan", 1, "Starting the probe."),
    command("probe", 2, "vp test run probe.test.ts"),
    proposal("proposal", 3, "Probe again with logging"),
    assistant("answer", 4, "The probe passed."),
  ]),
);

describe("resolveThreadFindReveal", () => {
  const reveal = (entryId: string) =>
    resolveThreadFindReveal({
      feed,
      latestRun: null,
      activeWorkStartedAt: null,
      runlessWorkActive: false,
      expandedRunIds: new Set(),
      expandedWorkGroupIds: new Set(),
      match: { entryId, runId },
    });

  it("opens the folds that hide a plan, and lands on the row that then shows it", () => {
    const target = reveal("proposal");
    expect(target?.runId).toBe(runId);
    const shown = deriveThreadFeedPresentation(
      feed,
      null,
      new Set([runId]),
      new Set(target?.workGroupId ? [target.workGroupId] : []),
    );
    const row = shown.find((candidate) => candidate.id === target?.rowId);
    expect(row?.type).toBe("activity-group");
    expect(
      row?.type === "activity-group" &&
        row.activities.some((activity) => activity.id === target?.activityId),
    ).toBe(true);
  });

  it("opens nothing for a message that is already on screen", () => {
    expect(reveal("answer")).toEqual({
      rowId: "answer",
      runId: null,
      workGroupId: null,
      activityId: null,
    });
  });

  it("leaves a match that has not loaded yet to history paging", () => {
    expect(threadFeedHoldsFindEntry(feed, "older")).toBe(false);
    expect(reveal("older")).toBeNull();
  });
});

describe("threadFindStartInRows", () => {
  it("counts from the first message or plan in the visible rows", () => {
    const rows = deriveThreadFeedPresentation(feed, null, new Set());
    const foldIndex = rows.findIndex((row) => row.type === "run-fold");
    expect(threadFindStartInRows(rows, foldIndex, rows.length - 1)).toEqual({
      entryId: "answer",
      occurrence: 0,
    });
    expect(threadFindStartInRows(rows, 0, rows.length - 1)).toEqual({
      entryId: "ask",
      occurrence: 0,
    });
    expect(threadFindStartInRows([], 0, 4)).toBeUndefined();
  });
});
