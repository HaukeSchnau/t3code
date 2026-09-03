import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { ProviderTranscriptJournalEntry } from "../persistence/Services/ProviderTranscriptJournal.ts";

import {
  batchProviderTranscriptJournalEntries,
  planProviderTranscriptJournalBatchSeals,
} from "./ProviderTranscriptJournalBatch.ts";

function delta(
  sequence: number,
  text: string,
  scope: { readonly turnId?: string; readonly itemId?: string } = {},
): ProviderTranscriptJournalEntry {
  return {
    sequence,
    batchId: null,
    event: {
      type: "content.delta",
      eventId: EventId.make(`event-${sequence}`),
      provider: ProviderDriverKind.make("codex"),
      createdAt: `2026-07-16T08:00:00.${String(sequence).padStart(3, "0")}Z`,
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make(scope.turnId ?? "turn-1"),
      itemId: RuntimeItemId.make(scope.itemId ?? "item-1"),
      payload: { streamKind: "assistant_text", delta: text },
    },
  };
}

function subagentBoundary(sequence: number) {
  const source = delta(sequence, "child");
  return {
    ...source,
    event: {
      ...source.event,
      agentContext: { providerThreadId: "provider-child-thread" },
    },
  } satisfies ProviderTranscriptJournalEntry;
}

describe("batchProviderTranscriptJournalEntries", () => {
  it("coalesces adjacent parent assistant deltas while retaining every durable source", () => {
    const first = delta(1, "one");
    const second = delta(2, " two");
    const third = delta(3, " three");

    const boundary = subagentBoundary(4);
    const batches = batchProviderTranscriptJournalEntries([first, second, third, boundary]);

    expect(batches).toHaveLength(2);
    expect(batches[0]?.event).toMatchObject({
      eventId: first.event.eventId,
      createdAt: first.event.createdAt,
      payload: { streamKind: "assistant_text", delta: "one two three" },
    });
    expect(batches[0]?.sourceEvents.map((event) => event.eventId)).toEqual([
      first.event.eventId,
      second.event.eventId,
      third.event.eventId,
    ]);
  });

  it("turns a token burst into one projection-sized batch", () => {
    const entries = Array.from({ length: 500 }, (_, index) => delta(index + 1, "x"));
    const boundary = subagentBoundary(501);

    const batches = batchProviderTranscriptJournalEntries([...entries, boundary]);

    expect(batches).toHaveLength(5);
    expect(batches.slice(0, -1).map((batch) => batch.sourceEvents.length)).toEqual([
      128, 128, 128, 116,
    ]);
    expect(
      batches
        .slice(0, -1)
        .map((batch) => (batch.event.type === "content.delta" ? batch.event.payload.delta : ""))
        .join(""),
    ).toHaveLength(500);
  });

  it("coalesces interleaved message streams without changing order within either message", () => {
    const firstA = delta(1, "a1", { turnId: "turn-a", itemId: "item-a" });
    const firstB = delta(2, "b1", { turnId: "turn-b", itemId: "item-b" });
    const secondA = delta(3, "a2", { turnId: "turn-a", itemId: "item-a" });
    const secondB = delta(4, "b2", { turnId: "turn-b", itemId: "item-b" });

    const boundary = subagentBoundary(5);
    const batches = batchProviderTranscriptJournalEntries([
      firstA,
      firstB,
      secondA,
      secondB,
      boundary,
    ]);

    expect(batches).toHaveLength(3);
    expect(
      batches.slice(0, -1).map((batch) => batch.sourceEvents.map((event) => event.eventId)),
    ).toEqual([
      [firstA.event.eventId, secondA.event.eventId],
      [firstB.event.eventId, secondB.event.eventId],
    ]);
    expect(
      batches
        .slice(0, -1)
        .map((batch) => (batch.event.type === "content.delta" ? batch.event.payload.delta : "")),
    ).toEqual(["a1a2", "b1b2"]);
  });

  it("preserves interleaved item order within one turn", () => {
    const firstA = delta(1, "a1", { itemId: "item-a" });
    const firstB = delta(2, "b1", { itemId: "item-b" });
    const secondA = delta(3, "a2", { itemId: "item-a" });
    const secondB = delta(4, "b2", { itemId: "item-b" });

    const batches = batchProviderTranscriptJournalEntries([firstA, firstB, secondA, secondB]);

    expect(batches.map((batch) => batch.sourceEvents[0]?.eventId)).toEqual([
      firstA.event.eventId,
      firstB.event.eventId,
      secondA.event.eventId,
      secondB.event.eventId,
    ]);
  });

  it("does not batch across a subagent or lifecycle boundary", () => {
    const before = delta(1, "before");
    const boundary = subagentBoundary(2);
    const after = delta(3, "after");

    const batches = batchProviderTranscriptJournalEntries([before, boundary, after]);

    expect(batches.map((batch) => batch.sourceEvents.map((event) => event.eventId))).toEqual([
      [before.event.eventId],
      [boundary.event.eventId],
      [after.event.eventId],
    ]);
  });

  it("collapses a sealed 4k two-turn replay from 4k projection writes to 32", () => {
    const entries = Array.from({ length: 4_000 }, (_, index) =>
      delta(index + 1, "x", {
        turnId: index % 2 === 0 ? "turn-a" : "turn-b",
        itemId: index % 2 === 0 ? "item-a" : "item-b",
      }),
    );

    const boundary = subagentBoundary(4_001);
    const batches = batchProviderTranscriptJournalEntries([...entries, boundary]);

    expect(batches).toHaveLength(33);
    expect(
      batches.slice(0, -1).reduce((count, batch) => count + batch.sourceEvents.length, 0),
    ).toBe(4_000);
  });

  it("keeps an unsealed tail's command identities stable when more deltas arrive", () => {
    const initial = [delta(1, "one"), delta(2, "two")];
    const initialBatches = batchProviderTranscriptJournalEntries(initial);
    const extendedBatches = batchProviderTranscriptJournalEntries([...initial, delta(3, "three")]);

    expect(initialBatches.map((batch) => batch.sourceEvents.map((event) => event.eventId))).toEqual(
      [[initial[0]!.event.eventId], [initial[1]!.event.eventId]],
    );
    expect(extendedBatches.slice(0, 2)).toEqual(initialBatches);

    const sealed = Array.from({ length: 128 }, (_, index) => delta(index + 1, "x"));
    const sealedBatches = batchProviderTranscriptJournalEntries(sealed);
    const sealedWithTail = batchProviderTranscriptJournalEntries([...sealed, delta(129, "tail")]);
    expect(sealedBatches).toHaveLength(1);
    expect(sealedWithTail[0]).toEqual(sealedBatches[0]);
    expect(sealedWithTail[1]?.sourceEvents).toEqual([sealedWithTail[1]?.event]);
  });

  it("freezes a partial live tail without admitting later rows", () => {
    const first = delta(1, "one");
    const second = delta(2, "two");
    const later = delta(3, "three");
    const [seal] = planProviderTranscriptJournalBatchSeals([first, second]);

    expect(seal?.sourceEvents.map((event) => event.eventId)).toEqual([
      first.event.eventId,
      second.event.eventId,
    ]);
    const sealedEntries = [first, second].map((entry) => ({
      ...entry,
      batchId: seal!.batchId,
    }));
    const initial = batchProviderTranscriptJournalEntries(sealedEntries);
    const extended = batchProviderTranscriptJournalEntries([...sealedEntries, later]);

    expect(initial).toHaveLength(1);
    expect(initial[0]?.event).toMatchObject({ payload: { delta: "onetwo" } });
    expect(extended[0]).toEqual(initial[0]);
    expect(extended[1]?.sourceEvents).toEqual([later.event]);
  });

  it("preserves first-occurrence timestamps for asymmetrically interleaved turns", () => {
    const firstA = delta(1, "a1", { turnId: "turn-a", itemId: "item-a" });
    const firstB = delta(2, "b1", { turnId: "turn-b", itemId: "item-b" });
    const secondB = delta(3, "b2", { turnId: "turn-b", itemId: "item-b" });
    const secondA = delta(4, "a2", { turnId: "turn-a", itemId: "item-a" });

    const batches = batchProviderTranscriptJournalEntries([
      firstA,
      firstB,
      secondB,
      secondA,
      subagentBoundary(5),
    ]);

    expect(batches.slice(0, 2).map((batch) => batch.event.createdAt)).toEqual([
      firstA.event.createdAt,
      firstB.event.createdAt,
    ]);
  });
});
