import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

import { makeProviderRuntimeEventLedger } from "./ProviderRuntimeEventLedger.ts";

const base = {
  provider: ProviderDriverKind.make("codex"),
  createdAt: "2026-08-09T00:00:00.000Z",
  threadId: ThreadId.make("thread-1"),
  turnId: TurnId.make("turn-1"),
};

function delta(eventId: string, itemId: string) {
  return {
    ...base,
    type: "content.delta",
    eventId: EventId.make(eventId),
    itemId: RuntimeItemId.make(itemId),
    payload: { streamKind: "assistant_text", delta: eventId },
  } satisfies ProviderRuntimeEvent;
}

describe("ProviderRuntimeEventLedger", () => {
  it.effect("suppresses exact identities without conflating independent items", () =>
    Effect.gen(function* () {
      const ledger = makeProviderRuntimeEventLedger();
      const first = delta("event-1", "item-1");
      const otherItem = delta("event-1", "item-2");

      expect(ledger.hasProcessed(first)).toBe(false);
      yield* ledger.rememberProcessed(first);
      expect(ledger.hasProcessed(first)).toBe(true);
      expect(ledger.hasProcessed(otherItem)).toBe(false);
      yield* ledger.reset;
    }),
  );

  it.effect("compacts completed item and turn scopes until session exit", () =>
    Effect.gen(function* () {
      const ledger = makeProviderRuntimeEventLedger();
      const first = delta("event-1", "item-1");
      yield* ledger.rememberProcessed(first);
      yield* ledger.rememberProcessed({
        ...base,
        type: "item.completed",
        eventId: EventId.make("item-completed"),
        itemId: RuntimeItemId.make("item-1"),
        payload: { itemType: "assistant_message", detail: "done" },
      });
      expect(ledger.hasProcessed(delta("new-event", "item-1"))).toBe(true);

      yield* ledger.rememberProcessed({
        ...base,
        type: "turn.completed",
        eventId: EventId.make("turn-completed"),
        payload: { state: "completed" },
      });
      expect(ledger.hasProcessed(delta("later-event", "later-item"))).toBe(true);

      yield* ledger.rememberProcessed({
        ...base,
        type: "session.exited",
        eventId: EventId.make("session-exited"),
        payload: { reason: "done", recoverable: false },
      });
      expect(ledger.hasProcessed(delta("later-event", "later-item"))).toBe(false);
      yield* ledger.reset;
    }),
  );
});
