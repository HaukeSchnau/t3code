import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { isQueuePausedAfterRun, queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";

describe("queued run delivery order", () => {
  it("keeps automatic completion delivery ahead of visible queued messages", () => {
    const projection = {
      messages: [
        { id: "message:visible-first" },
        {
          id: "message:automatic",
          delegatedCompletion: {
            generation: 1,
            parentRunId: "run:parent",
            taskIds: ["task:child"],
          },
        },
        { id: "message:visible-second" },
      ],
      runs: [
        {
          id: "run:visible-first",
          ordinal: 2,
          queuePosition: 1,
          status: "queued",
          userMessageId: "message:visible-first",
        },
        {
          id: "run:automatic",
          ordinal: 4,
          queuePosition: 3,
          status: "queued",
          userMessageId: "message:automatic",
        },
        {
          id: "run:visible-second",
          ordinal: 3,
          queuePosition: 2,
          status: "queued",
          userMessageId: "message:visible-second",
        },
      ],
    } as never;

    expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
      "run:automatic",
      "run:visible-first",
      "run:visible-second",
    ]);
  });
});


describe("queue pause after a terminal run", () => {
  it.each(["interrupted", "failed", "cancelled", "rolled_back"] as const)(
    "keeps queued work paused after %s, including after restart",
    (status) => {
      expect(isQueuePausedAfterRun([
        { ordinal: 1, status, startedAt: DateTime.makeUnsafe(1) },
        { ordinal: 2, status: "queued", startedAt: null },
      ])).toBe(true);
    },
  );
  it("resumes automatic delivery after a later successful turn", () => {
    expect(isQueuePausedAfterRun([
      { ordinal: 1, status: "failed", startedAt: null },
      { ordinal: 2, status: "queued", startedAt: null },
      { ordinal: 3, status: "completed", startedAt: null },
    ])).toBe(false);
  });
  it("does not pause delivery when an unstarted queued item is removed", () => {
    expect(isQueuePausedAfterRun([
      { ordinal: 1, status: "completed", startedAt: null },
      { ordinal: 2, status: "cancelled", startedAt: null },
      { ordinal: 3, status: "queued", startedAt: null },
    ])).toBe(false);
  });
});
