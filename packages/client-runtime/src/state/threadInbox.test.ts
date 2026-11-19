import {
  EnvironmentId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadAskId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createInboxReturnTracker,
  inboxReturnTime,
  isThreadWorking,
  sortInboxThreadsByReturn,
  sortThreadsByNeed,
  sortWorkingThreadsBySend,
  threadNeedsYou,
  threadsNeedingYou,
} from "./threadInbox.ts";

const environmentId = EnvironmentId.make("environment-1");

function thread(id: string, working: boolean) {
  return {
    id: ThreadId.make(id),
    environmentId,
    createdAt: "2026-06-01T00:00:00.000Z",
    unsettledAt: null,
    latestRun: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    runtime: working
      ? {
          status: "running" as const,
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: null,
          updatedAt: "2026-06-01T00:00:00.000Z",
        }
      : null,
  };
}

describe("createInboxReturnTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  it("stamps a thread when it stops working, but never on the first observation", () => {
    const tracker = createInboxReturnTracker();
    const first = tracker.observe([thread("a", true), thread("b", false)]);
    expect(first.returnedAt(thread("a", true))).toBeUndefined();
    expect(first.returnedAt(thread("b", false))).toBeUndefined();

    const held = tracker.observe([thread("a", false), thread("b", false)]);
    vi.advanceTimersByTime(2_000);
    const second = tracker.observe([thread("a", false), thread("b", false)]);
    expect(second.returnedAt(thread("a", false))).toBeDefined();
    expect(second.returnedAt(thread("b", false))).toBeUndefined();
    expect(tracker.returnedAt(thread("a", false))).toBe(second.returnedAt(thread("a", false)));
    // An earlier observation keeps its answer, so lists built from it stay valid.
    expect(held.isWorking(thread("a", false))).toBe(true);
    expect(held.returnedAt(thread("a", false))).toBeUndefined();
  });

  it("holds only placement, then expires and notifies without another shell event", () => {
    const tracker = createInboxReturnTracker();
    const notify = vi.fn();
    const unsubscribe = tracker.subscribe(notify);
    tracker.observe([thread("a", true)]);
    tracker.observe([thread("a", false)]);
    expect(isThreadWorking(thread("a", false))).toBe(false);
    expect(tracker.isWorking(thread("a", false))).toBe(true);
    vi.advanceTimersByTime(1_999);
    tracker.observe([thread("a", false)]);
    expect(tracker.isWorking(thread("a", false))).toBe(true);
    expect(tracker.returnedAt(thread("a", false))).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(tracker.isWorking(thread("a", false))).toBe(false);
    expect(tracker.returnedAt(thread("a", false))).toBe(12_000);
    expect(notify).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("lets a thread that stops working with an open ask leave Working at once", () => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", true)]);
    const asking = {
      ...thread("a", false),
      openAsks: [
        {
          id: ThreadAskId.make("ask"),
          source: { type: "turn_end" as const, runId: RunId.make("run-1") },
          text: "Delete the leftover dirs?",
          raisedAt: "2026-06-01T00:01:00.000Z",
        },
      ],
    };
    tracker.observe([asking]);
    expect(tracker.isWorking(asking)).toBe(false);
  });

  it("cancels a transient return on resume and grants a fresh grace after the next finish", () => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", false)]);
    expect(tracker.isWorking(thread("a", false))).toBe(false);
    tracker.observe([thread("a", true)]);
    expect(tracker.isWorking(thread("a", true))).toBe(true);
    tracker.observe([thread("a", false)]);
    vi.advanceTimersByTime(1_500);
    tracker.observe([thread("a", true)]);
    vi.advanceTimersByTime(1_000);
    expect(tracker.returnedAt(thread("a", true))).toBeUndefined();
    tracker.observe([thread("a", false)]);
    vi.advanceTimersByTime(1_999);
    expect(tracker.isWorking(thread("a", false))).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tracker.returnedAt(thread("a", false))).toBe(14_500);
  });

  it.each([
    { hasPendingApprovals: true },
    { hasPendingUserInput: true },
    { pendingSubagentRequest: "approval" as const },
    { pendingSubagentRequest: "user_input" as const },
    { pendingGuestMessageCount: 1 },
    { interactionMode: "plan" as const, hasActionableProposedPlan: true },
    { runtime: { ...thread("a", true).runtime!, status: "failed" as const, lastError: "failed" } },
    { pinnedAt: "2026-06-01T00:00:01Z" },
    { settledOverride: "settled" as const },
    { snoozedUntil: "2026-06-02T00:00:00Z" },
    { activeOrderKey: "manual-order" },
  ])("ends a grace immediately for attention or manual placement: %j", (change) => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", true)]);
    tracker.observe([thread("a", false)]);
    tracker.observe([{ ...thread("a", false), ...change }]);
    expect(tracker.isWorking(thread("a", false))).toBe(false);
    expect(tracker.returnedAt(thread("a", false))).toBe(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["interrupted", "cancelled", "rolled_back"] as const)(
    "holds a %s run, because the server can still settle it",
    (status) => {
      const tracker = createInboxReturnTracker();
      const stopped = {
        ...thread("a", false),
        latestRun: {
          runId: RunId.make("stopped"),
          status,
          requestedAt: null,
          startedAt: null,
          completedAt: null,
          assistantMessageId: null,
        },
      };
      tracker.observe([thread("a", true)]);
      tracker.observe([stopped]);
      expect(tracker.isWorking(stopped)).toBe(true);
      tracker.observe([{ ...stopped, settledOverride: "settled" as const }]);
      expect(tracker.isWorking(stopped)).toBe(false);
    },
  );

  it("grants grace after a retained expired snooze", () => {
    const tracker = createInboxReturnTracker();
    const retained = {
      snoozedAt: "1970-01-01T00:00:01.000Z",
      snoozedUntil: "1970-01-01T00:00:05.000Z",
      latestRun: {
        runId: RunId.make("completed-wake"),
        status: "completed" as const,
        requestedAt: "1970-01-01T00:00:02.000Z",
        startedAt: "1970-01-01T00:00:02.000Z",
        completedAt: "1970-01-01T00:00:09.000Z",
        assistantMessageId: null,
      },
    };
    const active = { ...thread("a", true), ...retained };
    const finished = { ...thread("a", false), ...retained };
    tracker.observe([active]);
    tracker.observe([finished]);
    expect(tracker.isWorking(finished)).toBe(true);
    expect(tracker.returnedAt(finished)).toBeUndefined();
    vi.advanceTimersByTime(1_999);
    expect(tracker.isWorking(finished)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tracker.isWorking(finished)).toBe(false);
    expect(tracker.returnedAt(finished)).toBe(12_000);
  });

  it("does not grant grace to a future snooze after background completion", () => {
    const tracker = createInboxReturnTracker();
    const retained = {
      snoozedAt: "1970-01-01T00:00:01.000Z",
      snoozedUntil: "1970-01-01T00:00:30.000Z",
    };
    tracker.observe([{ ...thread("a", true), ...retained }]);
    const finished = { ...thread("a", false), ...retained };
    tracker.observe([finished]);
    expect(tracker.isWorking(finished)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stamps only stable returns and sorts them in their actual return order", () => {
    const tracker = createInboxReturnTracker();
    const a = { ...thread("a", false), createdAt: "1970-01-01T00:00:00Z" };
    const b = { ...thread("b", false), createdAt: "1970-01-01T00:00:00Z" };
    tracker.observe([thread("a", true), thread("b", true)]);
    tracker.observe([a, thread("b", true)]);
    vi.advanceTimersByTime(500);
    tracker.observe([a, b]);
    vi.advanceTimersByTime(1_500);
    expect(tracker.returnedAt(a)).toBe(12_000);
    expect(tracker.returnedAt(b)).toBeUndefined();
    vi.advanceTimersByTime(500);
    expect(sortInboxThreadsByReturn([a, b], tracker.returnedAt).map((entry) => entry.id)).toEqual([
      "b",
      "a",
    ]);
  });

  it.each([
    ["completes", "completed", false],
    ["fails", "failed", true],
  ] as const)(
    "stamps a run the user did not start only when it fails, not when it %s",
    (_, status, stamped) => {
      const tracker = createInboxReturnTracker();
      const wake = (working: boolean) => ({
        ...thread("wake", working),
        latestRunStartedByUser: false,
        latestRun: {
          runId: RunId.make("run:wake"),
          status: working ? ("running" as const) : status,
          requestedAt: null,
          startedAt: null,
          completedAt: null,
          assistantMessageId: null,
        },
      });
      tracker.observe([wake(true)]);
      tracker.observe([wake(false)]);
      vi.advanceTimersByTime(2_000);
      expect(tracker.observe([wake(false)]).returnedAt(wake(false)) !== undefined).toBe(stamped);
    },
  );

  it("cancels pending timers for removed threads and disabled shelves", () => {
    const tracker = createInboxReturnTracker();
    const notify = vi.fn();
    tracker.subscribe(notify);
    tracker.observe([thread("a", true)]);
    tracker.observe([thread("a", false)]);
    tracker.observe([]);
    expect(vi.getTimerCount()).toBe(0);
    tracker.observe([thread("a", true)]);
    tracker.observe([thread("a", false)]);
    tracker.observe(null);
    vi.advanceTimersByTime(2_000);
    expect(notify).not.toHaveBeenCalled();
    expect(tracker.returnedAt(thread("a", false))).toBeUndefined();
  });
});

describe("inboxReturnTime", () => {
  it.each([
    ["a run the user started", true, "completed", Date.parse("2026-06-01T03:00:00.000Z")],
    [
      "a quiet run, from the user's last message",
      false,
      "completed",
      Date.parse("2026-06-01T01:00:00.000Z"),
    ],
    ["a failed quiet run", false, "failed", Date.parse("2026-06-01T03:00:00.000Z")],
  ] as const)("places %s", (_, latestRunStartedByUser, status, expected) => {
    expect(
      inboxReturnTime({
        ...thread("thread", false),
        latestUserAuthoredMessageAt: "2026-06-01T01:00:00.000Z",
        latestRunStartedByUser,
        latestRun: {
          runId: RunId.make("run:latest"),
          status,
          requestedAt: "2026-06-01T02:00:00.000Z",
          startedAt: "2026-06-01T02:00:00.000Z",
          completedAt: "2026-06-01T03:00:00.000Z",
          assistantMessageId: null,
        },
      }),
    ).toBe(expected);
  });

  it("orders by the server's return time, through quiet runs, reloads and observed returns", () => {
    // The user's run ended at 02:30; a wake ran after it and ended at 03:00.
    const quietAfterMine = {
      ...thread("thread", false),
      latestUserAuthoredMessageAt: "2026-06-01T01:00:00.000Z",
      returnedAt: "2026-06-01T02:30:00.000Z",
      latestRunStartedByUser: false,
      latestRun: {
        runId: RunId.make("run:wake"),
        status: "completed" as const,
        requestedAt: "2026-06-01T02:50:00.000Z",
        startedAt: "2026-06-01T02:50:00.000Z",
        completedAt: "2026-06-01T03:00:00.000Z",
        assistantMessageId: null,
      },
    };
    expect(inboxReturnTime(quietAfterMine)).toBe(Date.parse("2026-06-01T02:30:00.000Z"));
    expect(inboxReturnTime(quietAfterMine, () => Date.parse("2026-06-01T03:00:01.000Z"))).toBe(
      Date.parse("2026-06-01T02:30:00.000Z"),
    );
  });
});

describe("sortWorkingThreadsBySend", () => {
  it("orders by the last message the user sent, not by later runs", () => {
    const sentFirst = {
      ...thread("sent-first", true),
      latestUserAuthoredMessageAt: "2026-06-01T01:00:00.000Z",
      latestRun: {
        runId: RunId.make("run:wake"),
        status: "running" as const,
        requestedAt: "2026-06-01T04:00:00.000Z",
        startedAt: "2026-06-01T04:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    };
    const sentLast = {
      ...thread("sent-last", true),
      latestUserAuthoredMessageAt: "2026-06-01T02:00:00.000Z",
    };
    const launched = { ...thread("launched", true), latestUserAuthoredMessageAt: null };
    expect(
      sortWorkingThreadsBySend([launched, sentFirst, sentLast]).map((thread) => thread.id),
    ).toEqual(["sent-last", "sent-first", "launched"]);
  });
});

describe("threadNeedsYou", () => {
  const none = {
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingUserInputAt: null,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    openAsks: [],
  };
  const request = (card?: "secret" | "link") => ({
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make("request"),
      kind: card === undefined ? ("command" as const) : ("user_input" as const),
      createdAt: DateTime.makeUnsafe("2026-06-01T00:02:00.000Z"),
      ...(card === undefined ? {} : { card }),
    },
  });
  const ask = (id: string, type: "turn_end" | "page", raisedAt: string) => ({
    id: ThreadAskId.make(id),
    source:
      type === "page"
        ? { type, renderId: `render:${id}` }
        : { type, runId: RunId.make(`run:${id}`) },
    text: `Ask ${id}`,
    raisedAt,
  });
  const asks = [
    ask("page", "page", "2026-06-01T00:05:00.000Z"),
    ask("turn", "turn_end", "2026-06-01T00:03:00.000Z"),
  ];

  it.each([
    ["nothing", none, null],
    [
      "an approval before any ask",
      { ...none, hasPendingApprovals: true, openAsks: asks, source: request() },
      { kind: "approval", text: null, since: "2026-06-01T00:02:00.000Z" },
    ],
    [
      "a question",
      { ...none, hasPendingUserInput: true, pendingUserInputAt: "2026-06-01T00:04:00.000Z" },
      { kind: "question", text: null, since: "2026-06-01T00:04:00.000Z" },
    ],
    [
      "a secret card as a request",
      { ...none, hasPendingUserInput: true, source: request("secret") },
      { kind: "request", text: null, since: "2026-06-01T00:02:00.000Z" },
    ],
    [
      "a subagent's request",
      { ...none, pendingSubagentRequest: "approval" as const },
      { kind: "subagent", text: null, since: null },
    ],
    [
      "a guest's message, from when the oldest waiting one was sent",
      {
        ...none,
        pendingGuestMessageCount: 2,
        source: { pendingRuntimeRequest: null, pendingGuestMessageAt: "2026-06-01T00:01:00.000Z" },
      },
      { kind: "guest", text: null, since: "2026-06-01T00:01:00.000Z" },
    ],
    [
      "the oldest ask",
      { ...none, openAsks: asks },
      { kind: "turn_end", text: "Ask turn", since: "2026-06-01T00:03:00.000Z" },
    ],
  ] as const)("reports %s", (_, shell, need) => {
    expect(threadNeedsYou(shell)).toEqual(need);
  });

  it("orders the thread waiting longest first, and needs without a start after dated ones", () => {
    const shell = (
      id: string,
      updatedAt: string,
      fields: Partial<Parameters<typeof threadNeedsYou>[0]>,
    ) => ({
      ...none,
      ...fields,
      id: ThreadId.make(id),
      environmentId,
      updatedAt,
    });
    const threads = [
      // An older server sends no guest message time.
      shell("guest-undated", "2026-06-01T00:09:00.000Z", { pendingGuestMessageCount: 1 }),
      shell("page", "2026-06-01T00:01:00.000Z", { openAsks: [asks[0]!] }),
      shell("subagent", "2026-06-01T00:08:00.000Z", { pendingSubagentRequest: "approval" }),
      shell("question", "2026-06-01T00:00:00.000Z", {
        hasPendingUserInput: true,
        pendingUserInputAt: "2026-06-01T00:04:00.000Z",
      }),
      shell("turn", "2026-06-01T00:07:00.000Z", { openAsks: asks }),
      shell("guest", "2026-06-01T00:06:00.000Z", {
        pendingGuestMessageCount: 1,
        source: { pendingRuntimeRequest: null, pendingGuestMessageAt: "2026-06-01T00:02:00.000Z" },
      }),
    ];
    expect(sortThreadsByNeed(threads).map((thread) => thread.id)).toEqual([
      "guest",
      "turn",
      "question",
      "page",
      "subagent",
      "guest-undated",
    ]);
    // The count everywhere: the same order, without snoozed threads and threads that need nothing.
    const snoozed = {
      ...shell("snoozed", "2026-06-01T00:00:00.000Z", { openAsks: [asks[0]!] }),
      snoozedAt: "2026-06-01T00:05:00.000Z",
      snoozedUntil: "2026-06-02T00:00:00.000Z",
    };
    const idle = shell("idle", "2026-06-01T00:00:00.000Z", {});
    expect(
      threadsNeedingYou([...threads, snoozed, idle], { now: "2026-06-01T01:00:00.000Z" }).map(
        (thread) => thread.id,
      ),
    ).toEqual(["guest", "turn", "question", "page", "subagent", "guest-undated"]);
  });
});
