import {
  EventId,
  MessageId,
  ProviderDriverKind,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProviderTranscriptJournalLive } from "../persistence/Layers/ProviderTranscriptJournal.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProviderTranscriptJournal } from "../persistence/Services/ProviderTranscriptJournal.ts";
import { makeProviderTranscriptJournalIngestion } from "./ProviderTranscriptJournalIngestion.ts";

const layer = it.layer(
  ProviderTranscriptJournalLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const base = {
  provider: ProviderDriverKind.make("codex"),
  threadId: ThreadId.make("journal-ingestion-thread"),
  turnId: TurnId.make("journal-ingestion-turn"),
  itemId: RuntimeItemId.make("journal-ingestion-item"),
} as const;

layer("ProviderTranscriptJournalIngestion", (it) => {
  it.effect("seals a partial live assistant burst before dispatch", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const journal = yield* ProviderTranscriptJournal;
      yield* sql`PRAGMA foreign_keys = OFF`;
      const first = {
        ...base,
        turnId: TurnId.make("journal-live-batch-turn"),
        itemId: RuntimeItemId.make("journal-live-batch-item"),
        type: "content.delta",
        eventId: EventId.make("journal-live-batch-1"),
        createdAt: "2026-08-26T00:00:00.000Z",
        payload: { streamKind: "assistant_text", delta: "hello" },
      } as const satisfies ProviderRuntimeEvent;
      const second = {
        ...first,
        eventId: EventId.make("journal-live-batch-2"),
        createdAt: "2026-08-26T00:00:00.001Z",
        payload: { ...first.payload, delta: " world" },
      } as const satisfies ProviderRuntimeEvent;
      yield* journal.append(first);
      yield* journal.append(second);

      const remembered: ProviderRuntimeEvent[] = [];
      const delivered: ProviderRuntimeEvent[] = [];
      const ingestion = yield* makeProviderTranscriptJournalIngestion({
        hasProcessed: () => false,
        rememberProcessed: (event) => Effect.sync(() => remembered.push(event)),
      });
      yield* ingestion.drain(undefined, (event) => Effect.sync(() => delivered.push(event)));

      assert.lengthOf(delivered, 1);
      assert.equal(
        delivered[0]?.type === "content.delta" ? delivered[0].payload.delta : undefined,
        "hello world",
      );
      assert.deepStrictEqual(
        remembered.map((event) => event.eventId),
        [second.eventId],
      );
      const persisted = (yield* journal.list).filter(({ event }) =>
        event.eventId.startsWith("journal-live-batch-"),
      );
      assert.lengthOf(new Set(persisted.map(({ batchId }) => batchId)), 1);
      assert.notEqual(persisted[0]?.batchId, null);
      assert.deepStrictEqual(yield* journal.listUndelivered, []);
      yield* journal.removeMany([first, second]);
    }),
  );

  it.effect("replays the exact sealed batch after a failed dispatch", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const journal = yield* ProviderTranscriptJournal;
      yield* sql`PRAGMA foreign_keys = OFF`;
      const first = {
        ...base,
        turnId: TurnId.make("journal-recovery-batch-turn"),
        itemId: RuntimeItemId.make("journal-recovery-batch-item"),
        type: "content.delta",
        eventId: EventId.make("journal-recovery-batch-1"),
        createdAt: "2026-08-26T00:00:00.000Z",
        payload: { streamKind: "assistant_text", delta: "hello" },
      } as const satisfies ProviderRuntimeEvent;
      const second = {
        ...first,
        eventId: EventId.make("journal-recovery-batch-2"),
        createdAt: "2026-08-26T00:00:00.001Z",
        payload: { ...first.payload, delta: " world" },
      } as const satisfies ProviderRuntimeEvent;
      const later = {
        ...first,
        eventId: EventId.make("journal-recovery-batch-3"),
        createdAt: "2026-08-26T00:00:00.002Z",
        payload: { ...first.payload, delta: "!" },
      } as const satisfies ProviderRuntimeEvent;
      yield* journal.append(first);
      yield* journal.append(second);

      const beforeCrash = yield* makeProviderTranscriptJournalIngestion({
        hasProcessed: () => false,
        rememberProcessed: () => Effect.void,
      });
      yield* Effect.exit(
        beforeCrash.drain(undefined, () => Effect.fail("simulated dispatch crash")),
      );
      const sealedBeforeCrash = yield* journal.listUndelivered;
      assert.equal(sealedBeforeCrash[0]?.batchId, sealedBeforeCrash[1]?.batchId);
      assert.notEqual(sealedBeforeCrash[0]?.batchId, null);

      yield* journal.append(later);
      const delivered: ProviderRuntimeEvent[] = [];
      const afterCrash = yield* makeProviderTranscriptJournalIngestion({
        hasProcessed: () => false,
        rememberProcessed: () => Effect.void,
      });
      yield* afterCrash.recover((event) => Effect.sync(() => delivered.push(event)), Effect.void);

      assert.deepStrictEqual(
        delivered.map((event) =>
          event.type === "content.delta" ? event.payload.delta : event.type,
        ),
        ["hello world", "!"],
      );
      yield* journal.removeMany([first, second, later]);
    }),
  );

  it.effect("retires a delivered assistant item through its completion tombstone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const journal = yield* ProviderTranscriptJournal;
      yield* sql`PRAGMA foreign_keys = OFF`;

      const firstDelta = {
        ...base,
        type: "content.delta",
        eventId: EventId.make("journal-ingestion-delta-1"),
        createdAt: "2026-08-09T00:00:00.000Z",
        payload: { streamKind: "assistant_text", delta: "hello" },
      } as const satisfies ProviderRuntimeEvent;
      const secondDelta = {
        ...firstDelta,
        eventId: EventId.make("journal-ingestion-delta-2"),
        createdAt: "2026-08-09T00:00:00.010Z",
        payload: { ...firstDelta.payload, delta: " world" },
      } as const satisfies ProviderRuntimeEvent;
      const completion = {
        ...base,
        type: "item.completed",
        eventId: EventId.make("journal-ingestion-complete"),
        createdAt: "2026-08-09T00:00:00.020Z",
        payload: { itemType: "assistant_message", status: "completed" },
      } as const satisfies ProviderRuntimeEvent;
      yield* journal.append(firstDelta);
      yield* journal.append(secondDelta);
      yield* journal.append(completion);

      const remembered: ProviderRuntimeEvent[] = [];
      const ingestion = yield* makeProviderTranscriptJournalIngestion({
        hasProcessed: () => false,
        rememberProcessed: (event) => Effect.sync(() => remembered.push(event)),
      });
      const messageId = MessageId.make("assistant:journal-ingestion-item");
      const delivered: ProviderRuntimeEvent[] = [];

      yield* ingestion.drain(undefined, (event) =>
        Effect.sync(() => {
          delivered.push(event);
          if (event.type === "content.delta") {
            ingestion.bufferAssistantSourceEvents(messageId, event);
          } else if (
            event.type === "item.completed" &&
            event.payload.itemType === "assistant_message"
          ) {
            ingestion.promoteBufferedAssistantEvents(messageId, event);
          }
        }),
      );

      assert.deepStrictEqual(
        delivered.map((event) => event.eventId),
        [firstDelta.eventId, completion.eventId],
      );
      assert.deepStrictEqual(
        remembered.map((event) => event.eventId),
        [secondDelta.eventId],
      );
      assert.deepStrictEqual(yield* journal.list, []);
      assert.isTrue(yield* journal.isItemCompleted(completion));
    }),
  );
});
