import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { batchProviderTranscriptJournalEntries } from "./ProviderTranscriptJournalBatch.ts";

function delta(
  sequence: number,
  text: string,
): {
  readonly sequence: number;
  readonly event: ProviderRuntimeEvent;
} {
  return {
    sequence,
    event: {
      type: "content.delta",
      eventId: EventId.make(`event-${sequence}`),
      provider: ProviderDriverKind.make("codex"),
      createdAt: `2026-07-16T08:00:00.${String(sequence).padStart(3, "0")}Z`,
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      itemId: RuntimeItemId.make("item-1"),
      payload: { streamKind: "assistant_text", delta: text },
    },
  };
}

describe("batchProviderTranscriptJournalEntries", () => {
  it("coalesces adjacent parent assistant deltas while retaining every durable source", () => {
    const first = delta(1, "one");
    const second = delta(2, " two");
    const third = delta(3, " three");

    const batches = batchProviderTranscriptJournalEntries([first, second, third]);

    expect(batches).toHaveLength(1);
    expect(batches[0]?.event).toMatchObject({
      eventId: first.event.eventId,
      createdAt: third.event.createdAt,
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

    const batches = batchProviderTranscriptJournalEntries(entries);

    expect(batches).toHaveLength(1);
    expect(batches[0]?.sourceEvents).toHaveLength(500);
    expect(
      batches[0]?.event.type === "content.delta" ? batches[0].event.payload.delta : "",
    ).toHaveLength(500);
  });
});
