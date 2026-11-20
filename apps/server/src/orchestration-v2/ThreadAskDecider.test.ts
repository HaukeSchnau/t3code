import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadAskId,
  ThreadId,
  type OrchestrationV2AppThread,
  type ThreadAsk,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  decideThreadAskCommand,
  dismissOpenAsks,
  threadAfterCancelledReply,
  threadAfterUserReply,
  type ThreadAskCommand,
} from "./ThreadAskDecider.ts";

const threadId = ThreadId.make("thread:asks");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 19, 12, minute));
const now = at(30);

const thread = (overrides: Partial<OrchestrationV2AppThread> = {}): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId: ProjectId.make("project:asks"),
  title: "Asks",
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: at(0),
  updatedAt: at(0),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
  ...overrides,
});

const run = (id: string, ordinal: number, completedMinute: number) => ({
  id: RunId.make(id),
  ordinal,
  status: "completed" as const,
  completedAt: at(completedMinute),
});
const runs = [run("run-1", 1, 10), run("run-2", 2, 20), run("run-3", 3, 25)];

const open = (id: string, source: ThreadAsk["source"], minute: number): ThreadAsk => ({
  id: ThreadAskId.make(id),
  source,
  text: `Ask ${id}`,
  raisedAt: DateTime.formatIso(at(minute)),
  status: "open",
});
const turnEnd = (runId: string) => ({ type: "turn_end" as const, runId: RunId.make(runId) });
const page = (renderId: string) => ({ type: "page" as const, renderId });

const raise = (id: string, source: ThreadAsk["source"], text = `Ask ${id}`): ThreadAskCommand => ({
  type: "thread.ask.raise",
  commandId: CommandId.make(`raise:${id}`),
  threadId,
  askId: ThreadAskId.make(id),
  source,
  text,
});

const decide = (
  current: OrchestrationV2AppThread,
  command: ThreadAskCommand,
  latestUserReplyAt: DateTime.Utc | null = null,
  threadRuns: ReadonlyArray<ReturnType<typeof run>> = runs,
) => decideThreadAskCommand({ thread: current, command, now, runs: threadRuns, latestUserReplyAt });

const statuses = (decided: OrchestrationV2AppThread) =>
  (decided.asks ?? []).map((ask) => `${ask.id}:${ask.status}`);

describe("decideThreadAskCommand", () => {
  it("raises a turn-end ask and lets a later run's ask replace it", () => {
    const first = decide(thread(), raise("a", turnEnd("run-2")));
    expect(statuses(first)).toEqual(["a:open"]);
    const second = decide(first, raise("b", turnEnd("run-3")));
    expect(statuses(second)).toEqual(["a:replaced", "b:open"]);
    expect(second.asks?.[0]?.resolvedAt).toBe(DateTime.formatIso(now));
  });

  it("drops a turn-end ask the user replied to after the run ended, not before", () => {
    const current = thread();
    expect(decide(current, raise("a", turnEnd("run-2")), at(21))).toBe(current);
    expect(statuses(decide(current, raise("a", turnEnd("run-2")), at(15)))).toEqual(["a:open"]);
  });

  it("follows completion and arrival order when queued runs finish out of order", () => {
    // run-2 was queued first but ended last; the reply that started run-3 came before that.
    const reordered = [run("run-2", 2, 27), run("run-3", 3, 25)];
    const current = thread({ asks: [open("b", turnEnd("run-3"), 26)] });
    expect(statuses(decide(current, raise("a", turnEnd("run-2")), at(15), reordered))).toEqual([
      "b:replaced",
      "a:open",
    ]);
  });

  it.each(["open", "answered", "dismissed", "replaced"] as const)(
    "drops an older run's late ask under a newer run's %s ask",
    (status) => {
      const current = thread({ asks: [{ ...open("b", turnEnd("run-3"), 26), status }] });
      expect(decide(current, raise("a", turnEnd("run-2")))).toBe(current);
    },
  );

  it("raises a run's ask only once, even after it was answered", () => {
    const current = thread({
      asks: [{ ...open("a", turnEnd("run-2"), 21), status: "answered" }],
    });
    expect(decide(current, raise("again", turnEnd("run-2")))).toBe(current);
  });

  it("updates the text and run of a page's open ask instead of adding another", () => {
    const byRun = (runId: string) => ({ ...page("render-1"), runId: RunId.make(runId) });
    const first = decideThreadAskCommand({
      thread: thread(),
      command: raise("p", byRun("run-2"), "Pick a layout"),
      now: at(12),
      runs,
      latestUserReplyAt: null,
    });
    const second = decide(first, raise("p2", byRun("run-3"), "Pick a layout and a color"));
    expect(second.asks?.map((ask) => [ask.id, ask.text, ask.source, ask.raisedAt])).toEqual([
      ["p", "Pick a layout and a color", byRun("run-3"), DateTime.formatIso(at(12))],
    ]);
    // The same text from another run still moves the ask to that run.
    const third = decide(second, raise("p3", byRun("run-4"), "Pick a layout and a color"));
    expect(third.asks?.[0]?.source).toEqual(byRun("run-4"));
    expect(decide(third, raise("p4", byRun("run-4"), "Pick a layout and a color"))).toBe(third);
  });

  it("returns the thread to the inbox with a new ask, and brings a settled thread back", () => {
    const decided = decide(
      thread({ settledOverride: "settled", settledAt: at(5) }),
      raise("p", page("render-1")),
    );
    expect([
      decided.settledOverride,
      decided.settledAt,
      decided.unsettledAt,
      decided.returnedAt,
    ]).toEqual([null, null, now, DateTime.formatIso(now)]);
    // A page that only rewords its open ask does not return the thread again.
    const reworded = decide(
      { ...decided, returnedAt: "2026-01-01T00:00:00.000Z" },
      raise("p2", page("render-1"), "Pick one"),
    );
    expect(reworded.returnedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("withdraws only the open ask of the named page", () => {
    const current = thread({
      asks: [open("p1", page("render-1"), 1), open("p2", page("render-2"), 2)],
    });
    const withdraw: ThreadAskCommand = {
      type: "thread.ask.withdraw",
      commandId: CommandId.make("withdraw"),
      threadId,
      renderId: "render-1",
    };
    expect(statuses(decide(current, withdraw))).toEqual(["p1:withdrawn", "p2:open"]);
  });

  it("dismisses one ask by id, or every open ask", () => {
    const current = thread({
      asks: [open("t", turnEnd("run-1"), 11), open("p", page("render-1"), 12)],
    });
    const dismiss = (askId?: string): ThreadAskCommand => ({
      type: "thread.ask.dismiss",
      commandId: CommandId.make("dismiss"),
      threadId,
      ...(askId === undefined ? {} : { askId: ThreadAskId.make(askId) }),
    });
    expect(statuses(decide(current, dismiss("p")))).toEqual(["t:open", "p:dismissed"]);
    const all = decide(current, dismiss());
    expect(statuses(all)).toEqual(["t:dismissed", "p:dismissed"]);
    expect(decide(all, dismiss())).toBe(all);
  });

  it("keeps every open ask and only the newest resolved ones", () => {
    const resolved = Array.from({ length: 25 }, (_, index) => ({
      ...open(`old-${index}`, page(`render-${index}`), 0),
      status: "dismissed" as const,
    }));
    const decided = decide(thread({ asks: resolved }), raise("new", page("render-new")));
    expect(decided.asks).toHaveLength(20);
    expect(decided.asks?.at(0)?.id).toBe("old-6");
    expect(decided.asks?.at(-1)?.id).toBe("new");
  });
});

describe("user replies", () => {
  const replyId = MessageId.make("reply-1");
  const reply = (id: string, minute: number, runId: string | null) => ({
    id: MessageId.make(id),
    runId: runId === null ? null : RunId.make(runId),
    role: "user" as const,
    createdBy: "user" as const,
    creationSource: "web" as const,
    text: `Reply ${id}`,
    attachments: [],
    createdAt: at(minute),
  });
  const queuedRun = (id: string, status: "queued" | "cancelled") => ({
    id: RunId.make(id),
    status,
    startedAt: null,
  });

  it("answers every open ask; a cancelled reply passes them to the next reply or opens them", () => {
    const current = thread({
      asks: [
        { ...open("old", page("render-0"), 1), status: "dismissed" },
        open("t", turnEnd("run-1"), 11),
        open("p", page("render-1"), 12),
      ],
    });
    const answered = threadAfterUserReply(current, replyId, now);
    expect(statuses(answered)).toEqual(["old:dismissed", "t:answered", "p:answered"]);
    expect(answered.asks?.[1]?.answeredBy).toBe(replyId);

    // reply-2 queued behind reply-1; "before" came before the asks and answers neither.
    const messages = [
      reply("before", 5, null),
      reply(replyId, 13, "q1"),
      reply("reply-2", 14, "q2"),
    ];
    const passed = threadAfterCancelledReply(answered, replyId, now, {
      messages,
      runs: [queuedRun("q1", "queued"), queuedRun("q2", "queued")],
    });
    expect(statuses(passed)).toEqual(["old:dismissed", "t:answered", "p:answered"]);
    expect(passed.asks?.map((ask) => ask.answeredBy)).toEqual([undefined, "reply-2", "reply-2"]);

    const reopened = threadAfterCancelledReply(passed, MessageId.make("reply-2"), now, {
      messages,
      runs: [queuedRun("q1", "cancelled"), queuedRun("q2", "queued")],
    });
    expect(statuses(reopened)).toEqual(["old:dismissed", "t:open", "p:open"]);
    expect(reopened.asks?.[1]).toEqual(current.asks?.[1]);
  });

  it.each(["open", "dismissed"] as const)(
    "leaves an answered ask closed when a newer %s ask took its place",
    (status) => {
      const answered = threadAfterUserReply(
        thread({ asks: [open("t", turnEnd("run-1"), 11), open("p", page("render-1"), 12)] }),
        replyId,
        now,
      );
      const newer = {
        ...answered,
        asks: [
          ...(answered.asks ?? []),
          { ...open("t2", turnEnd("run-2"), 21), status },
          { ...open("p2", page("render-1"), 22), status },
        ],
      };
      expect(threadAfterCancelledReply(newer, replyId, now, { messages: [], runs: [] })).toBe(
        newer,
      );
    },
  );

  it("changes nothing without open asks", () => {
    const current = thread({ asks: [{ ...open("t", turnEnd("run-1"), 11), status: "dismissed" }] });
    expect(threadAfterUserReply(current, replyId, now)).toBe(current);
    expect(dismissOpenAsks(current.asks ?? [], now)).toBe(current.asks);
  });
});
