import { EnvironmentId, RunId, RuntimeRequestId, ThreadAskId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_NEEDS_YOU_DECK,
  makeNeedsYouDraftStore,
  NEEDS_YOU_SEND_BUSY,
  needsYouAnswers,
  needsYouAnswerSent,
  needsYouCard,
  needsYouDeckIndex,
  needsYouDeckThreads,
  needsYouPageFrame,
  reconcileNeedsYouDeck,
  stepNeedsYouDeck,
} from "./needsYouTriage.ts";
import type { AtomCommandResult } from "./runtime.ts";

const environmentId = EnvironmentId.make("environment-1");
const NOW = "2026-06-01T12:00:00.000Z";

function thread(
  id: string,
  options: {
    readonly askedAt?: string;
    readonly archived?: boolean;
    readonly snoozedUntil?: string;
    readonly environment?: string;
  } = {},
) {
  return {
    id: ThreadId.make(id),
    environmentId:
      options.environment === undefined ? environmentId : EnvironmentId.make(options.environment),
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: options.archived ? "2026-06-01T01:00:00.000Z" : null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    snoozedAt: options.snoozedUntil === undefined ? null : "2026-06-01T11:00:00.000Z",
    snoozedUntil: options.snoozedUntil ?? null,
    openAsks:
      options.askedAt === undefined
        ? []
        : [
            {
              id: ThreadAskId.make(`turn_end:${id}`),
              source: { type: "turn_end" as const, runId: RunId.make(`run-${id}`) },
              text: `Ask ${id}`,
              raisedAt: options.askedAt,
            },
          ],
  };
}

describe("needsYouDeckThreads", () => {
  it("deals the Needs you section's threads under the list's filter and snooze rule", () => {
    const deck = needsYouDeckThreads(
      [
        thread("newer", { askedAt: "2026-06-01T10:00:00.000Z" }),
        thread("quiet"),
        thread("archived", { askedAt: "2026-06-01T08:00:00.000Z", archived: true }),
        thread("snoozed", {
          askedAt: "2026-06-01T08:00:00.000Z",
          snoozedUntil: "2026-06-01T13:00:00.000Z",
        }),
        // The list shows a snooze only once it knows the environment supports it.
        thread("snoozed-unknown", {
          askedAt: "2026-06-01T07:00:00.000Z",
          snoozedUntil: "2026-06-01T13:00:00.000Z",
          environment: "environment-2",
        }),
        thread("subagent", { askedAt: "2026-06-01T08:00:00.000Z" }),
        thread("other-project", { askedAt: "2026-06-01T08:00:00.000Z" }),
        thread("older", { askedAt: "2026-06-01T09:00:00.000Z" }),
      ],
      {
        now: NOW,
        isListed: (candidate) => candidate.id !== "subagent" && candidate.id !== "other-project",
        honorsSnooze: (candidate) => candidate.environmentId === environmentId,
      },
    );
    expect(deck.map((candidate) => candidate.id)).toEqual(["snoozed-unknown", "older", "newer"]);
  });
});

describe("reconcileNeedsYouDeck", () => {
  const dealt = reconcileNeedsYouDeck(EMPTY_NEEDS_YOU_DECK, ["a", "b", "c"]);

  it("starts on the first card and stays on it while others come and go", () => {
    expect(dealt.current).toBe("a");
    const onB = stepNeedsYouDeck(dealt, 1);
    const moved = reconcileNeedsYouDeck(onB, ["new", "a", "b"]);
    expect(moved.current).toBe("b");
    expect(needsYouDeckIndex(moved)).toBe(2);
    expect(reconcileNeedsYouDeck(moved, ["new", "a", "b"])).toBe(moved);
  });

  it("moves on to the card after one that left, and back from the end", () => {
    const onB = stepNeedsYouDeck(dealt, 1);
    expect(reconcileNeedsYouDeck(onB, ["a", "c"]).current).toBe("c");
    // A card that arrived meanwhile, even one waiting longer, comes after the next one.
    expect(reconcileNeedsYouDeck(onB, ["new", "a", "c"]).current).toBe("c");
    // The next card left with it; a card that arrived meanwhile comes next.
    expect(reconcileNeedsYouDeck(onB, ["a", "d"]).current).toBe("d");
    const onC = stepNeedsYouDeck(onB, 1);
    expect(reconcileNeedsYouDeck(onC, ["a", "b"]).current).toBe("b");
    const empty = reconcileNeedsYouDeck(onC, []);
    expect(empty.current).toBeNull();
    expect(needsYouDeckIndex(empty)).toBe(-1);
  });

  it("keeps a reply until its send lands, what was typed after it, and one send at a time", async () => {
    const held = new Set<string>();
    const outboxListeners = new Set<() => void>();
    let read = Promise.resolve();
    const outbox = {
      loaded: () => read,
      holdsThread: (key: string) => held.has(key),
      subscribe: (listener: () => void) => {
        outboxListeners.add(listener);
        return () => void outboxListeners.delete(listener);
      },
    };
    const release = (key: string) => {
      held.delete(key);
      for (const listener of outboxListeners) listener();
    };
    const session = makeNeedsYouDraftStore(outbox);
    session.set("a", "Use the blue one");
    session.set("b", "Ship it");
    await session.send("a", () => Promise.resolve(true), "Use the blue one");
    expect(session.getSnapshot().drafts).toEqual({ b: "Ship it" });

    let land = (_sent: boolean) => {};
    let deliveries = 0;
    const deliver = () => {
      deliveries += 1;
      return new Promise<boolean>((resolve) => {
        land = resolve;
      });
    };
    const pending = session.send("b", deliver, "Ship it");
    // Typed on while the send was pending: the send leaves the new text alone.
    session.set("b", "Ship it, then tag it");
    // Triage closed and opened again before the send landed: Send waits for it.
    expect(session.sending("b")).toBe(true);
    expect(await session.send("b", deliver, "Ship it, then tag it")).toBe(false);
    // A page on the card sends under the same rule and sees why it may not.
    await expect(session.sendFromPage("b", deliver)).rejects.toThrow(NEEDS_YOU_SEND_BUSY);
    expect(deliveries).toBe(1);
    land(true);
    await pending;
    expect(session.getSnapshot()).toEqual({ drafts: { b: "Ship it, then tag it" } });
    expect(session.sending("b")).toBe(false);

    // A reply the outbox holds, offline say, stays on its way until the outbox lets it go.
    await session.send(
      "b",
      async () => {
        held.add("b");
        return true;
      },
      "Ship it, then tag it",
    );
    expect(session.getSnapshot()).toEqual({ drafts: {} });
    expect(session.sending("b")).toBe(true);
    await expect(session.sendFromPage("b", deliver)).rejects.toThrow(NEEDS_YOU_SEND_BUSY);
    release("b");
    expect(session.sending("b")).toBe(false);
    const fromPage = session.sendFromPage("b", deliver);
    expect(deliveries).toBe(2);
    land(true);
    await fromPage;

    // After a restart the outbox reads what it saved only once triage is open, and finds a reply
    // that no send of the new session started. Until then, any thread may hold one.
    let finishRead = () => {};
    read = new Promise((resolve) => {
      finishRead = resolve;
    });
    const restarted = makeNeedsYouDraftStore(outbox);
    let heard = 0;
    const unsubscribe = restarted.subscribe(() => void (heard += 1));
    expect(restarted.sending("a")).toBe(true);
    const early = restarted.sendFromPage("b", async () => {
      deliveries += 1;
      return true;
    });
    held.add("b");
    finishRead();
    await expect(early).rejects.toThrow(NEEDS_YOU_SEND_BUSY);
    expect(deliveries).toBe(2);
    // It heard the page's send start, the read end and the send give up.
    expect(heard).toBe(3);
    expect(restarted.sending("a")).toBe(false);
    expect(restarted.sending("b")).toBe(true);
    release("b");
    expect(heard).toBe(4);
    expect(restarted.sending("b")).toBe(false);
    unsubscribe();
  });

  it("steps between cards and stops at either end", () => {
    expect(stepNeedsYouDeck(dealt, -1)).toBe(dealt);
    const last = stepNeedsYouDeck(stepNeedsYouDeck(dealt, 1), 1);
    expect(last.current).toBe("c");
    expect(stepNeedsYouDeck(last, 1)).toBe(last);
  });
});

describe("needsYouCard", () => {
  const option = { label: "Blue", description: "The calm one" };
  const question = (
    questions: number,
    extra: {
      readonly multiSelect?: boolean;
      readonly allowCustomAnswer?: boolean;
      readonly initialAnswer?: string;
    } = {},
  ) => ({
    requestId: RuntimeRequestId.make("request-1"),
    createdAt: "2026-06-01T09:00:00.000Z",
    responseCapability: "live" as const,
    dismissible: false,
    questions: Array.from({ length: questions }, (_, index) => ({
      id: `q${index}`,
      header: "Logo",
      question: "Which color?",
      options: [option],
      multiSelect: extra.multiSelect ?? false,
      ...(extra.allowCustomAnswer === undefined
        ? {}
        : { allowCustomAnswer: extra.allowCustomAnswer }),
      ...(extra.initialAnswer === undefined ? {} : { initialAnswer: extra.initialAnswer }),
    })),
  });
  const asking = {
    ...thread("q"),
    hasPendingUserInput: true,
    pendingUserInputAt: "2026-06-01T09:00:00.000Z",
  };
  const offers = (card: ReturnType<typeof needsYouCard>) => ({
    reply: card.replyMode,
    options: card.question?.options.length ?? 0,
    here: card.answersHere,
    waitingOn: card.waitingOn.length,
  });

  it("answers asks with a reply and single questions in place, and opens the thread otherwise", () => {
    const rows: never[] = [];
    expect(
      offers(
        needsYouCard({
          thread: thread("t", { askedAt: NOW }),
          rows,
          requests: null,
        }),
      ),
    ).toEqual({ reply: "message", options: 0, here: true, waitingOn: 0 });
    expect(
      offers(
        needsYouCard({
          thread: asking,
          rows,
          requests: { approvals: [], userInputs: [question(1)] },
        }),
      ),
    ).toEqual({ reply: "answer", options: 1, here: true, waitingOn: 0 });
    expect(
      offers(
        needsYouCard({
          thread: asking,
          rows,
          requests: { approvals: [], userInputs: [question(1, { allowCustomAnswer: false })] },
        }),
      ),
    ).toEqual({ reply: null, options: 1, here: true, waitingOn: 0 });
    // An editor prompt hands the user text to edit, which the thread's own card keeps verbatim.
    for (const pending of [
      question(2),
      question(1, { multiSelect: true }),
      question(1, { initialAnswer: "  keep this indent" }),
    ]) {
      expect(
        offers(
          needsYouCard({
            thread: asking,
            rows,
            requests: { approvals: [], userInputs: [pending] },
          }),
        ),
      ).toEqual({
        reply: null,
        options: 0,
        here: false,
        waitingOn: pending.questions.length,
      });
    }
    expect(
      offers(
        needsYouCard({
          thread: { ...thread("a", { askedAt: NOW }), hasPendingApprovals: true },
          rows,
          requests: {
            approvals: [
              {
                requestId: RuntimeRequestId.make("approval-1"),
                requestKind: "command",
                createdAt: NOW,
                detail: "rm -rf dist",
                responseCapability: "live",
              },
            ],
            userInputs: [],
          },
        }),
      ),
    ).toEqual({ reply: null, options: 0, here: false, waitingOn: 1 });
  });

  it("sends answers the way the thread's question card builds them", () => {
    const only = {
      id: "q0",
      options: [{ label: " Blue " }, { label: "Teal", value: " teal " }],
    };
    expect(needsYouAnswers(only, { option: " Blue " })).toEqual({ q0: "Blue" });
    expect(needsYouAnswers(only, { option: " teal " })).toEqual({ q0: " teal " });
    expect(needsYouAnswers(only, { option: "Red" })).toBeNull();
    expect(needsYouAnswers(only, { text: "  Navy  " })).toEqual({ q0: "Navy" });
    expect(needsYouAnswers(only, { text: "   " })).toBeNull();
  });

  it("keeps an answer's draft unless it went out, and reports failures but not interrupts", async () => {
    const session = makeNeedsYouDraftStore({
      loaded: () => Promise.resolve(),
      holdsThread: () => false,
      subscribe: () => () => undefined,
    });
    const reported: unknown[] = [];
    const answer = (result: AtomCommandResult<unknown, unknown>) => async () =>
      needsYouAnswerSent(result, (error) => reported.push(error));
    session.set("a", "Navy");
    // Cut off on the way, it may never have arrived.
    await session.send("a", answer(AsyncResult.failure(Cause.interrupt())), "Navy");
    expect(session.getSnapshot().drafts).toEqual({ a: "Navy" });
    expect(reported).toEqual([]);
    const declined = new Error("The question was already answered.");
    await session.send("a", answer(AsyncResult.failure(Cause.fail(declined))), "Navy");
    expect(session.getSnapshot().drafts).toEqual({ a: "Navy" });
    expect(reported).toEqual([declined]);
    await session.send("a", answer(AsyncResult.success(undefined)), "Navy");
    expect(session.getSnapshot().drafts).toEqual({});
  });

  it("mounts a page the timeline does not hold from the page index, under its render id", () => {
    const render = { attachmentId: "render-1", title: "Logos", height: 300 };
    const versions = [{ itemId: "item-1", htmlRender: render }];
    expect(needsYouPageFrame({ renderId: "render-1", versions }, null)).toEqual({
      render,
      versions,
    });
    const indexed = [
      { renderId: "render-0", latestAttachmentId: "render-0", title: "Other" },
      { renderId: "render-1", latestAttachmentId: "render-1-v3", title: "Logos v3" },
    ];
    const frame = needsYouPageFrame({ renderId: "render-1", versions: null }, indexed);
    expect(frame?.render.attachmentId).toBe("render-1");
    expect(frame?.versions.map((version) => version.htmlRender.attachmentId)).toEqual([
      "render-1-v3",
    ]);
    expect(needsYouPageFrame({ renderId: "render-2", versions: null }, indexed)).toBeNull();
  });
});
