import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProviderTranscriptJournal } from "../Services/ProviderTranscriptJournal.ts";
import { ProviderTranscriptJournalLive } from "./ProviderTranscriptJournal.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProviderTranscriptJournalLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const base = {
  provider: ProviderDriverKind.make("codex"),
  threadId: ThreadId.make("journal-thread"),
  turnId: TurnId.make("journal-turn"),
  itemId: RuntimeItemId.make("journal-item"),
} as const;

layer("ProviderTranscriptJournal", (it) => {
  it.effect("orders item completion at the durable acceptance boundary", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const journal = yield* ProviderTranscriptJournal;
      // The repository's foreign key is exercised by integration tests. This
      // unit isolates the atomic conditional INSERT without projection setup.
      yield* sql`PRAGMA foreign_keys = OFF`;

      const delta = {
        ...base,
        type: "content.delta",
        eventId: EventId.make("journal-delta"),
        createdAt: "2026-07-14T00:00:00.000Z",
        payload: { streamKind: "assistant_text", delta: "accepted" },
      } as const satisfies ProviderRuntimeEvent;
      const completion = {
        ...base,
        type: "item.completed",
        eventId: EventId.make("journal-completed"),
        createdAt: "2026-07-14T00:00:00.100Z",
        payload: {
          itemType: "assistant_message",
          status: "completed",
          detail: "accepted with trailing newline\n",
        },
      } as const satisfies ProviderRuntimeEvent;
      const lateDelta = {
        ...delta,
        eventId: EventId.make("journal-late-delta"),
        createdAt: "2026-07-14T00:00:00.200Z",
        payload: { ...delta.payload, delta: "must not be accepted" },
      } as const satisfies ProviderRuntimeEvent;

      assert.isTrue(yield* journal.append(delta));
      assert.isTrue(yield* journal.append(completion));
      assert.isFalse(yield* journal.append(lateDelta));
      const persisted = yield* journal.list;
      assert.deepStrictEqual(
        persisted.map(({ event }) => event.eventId),
        [delta.eventId, completion.eventId],
      );
      const persistedCompletion = persisted[1]?.event;
      assert.equal(
        persistedCompletion?.type === "item.completed"
          ? persistedCompletion.payload.detail
          : undefined,
        completion.payload.detail,
      );
    }),
  );

  it.effect("acknowledges in bulk and rolls back a multi-chunk removal atomically", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const journal = yield* ProviderTranscriptJournal;
      yield* sql`PRAGMA foreign_keys = OFF`;
      const initialEntries = yield* journal.list;

      const events = Array.from(
        { length: 501 },
        (_, index) =>
          ({
            ...base,
            turnId: TurnId.make("journal-bulk-turn"),
            itemId: RuntimeItemId.make("journal-bulk-item"),
            type: "content.delta",
            eventId: EventId.make(`journal-bulk-${index}`),
            createdAt: `2026-07-14T00:00:01.${String(index).padStart(3, "0")}Z`,
            payload: { streamKind: "assistant_text", delta: "x" },
          }) as const satisfies ProviderRuntimeEvent,
      );
      yield* Effect.forEach(events, journal.append, { concurrency: 1, discard: true });

      yield* sql`
        CREATE TRIGGER reject_last_bulk_delivery
        BEFORE UPDATE OF delivered ON provider_transcript_journal
        WHEN OLD.event_id = 'journal-bulk-500'
        BEGIN
          SELECT RAISE(ABORT, 'injected bulk delivery failure');
        END
      `;
      const delivery = yield* Effect.exit(journal.markDeliveredMany(events));
      assert.isTrue(Exit.isFailure(delivery));
      const bulkEventIds = new Set(events.map((event) => event.eventId));
      assert.lengthOf(
        (yield* journal.listUndelivered).filter(({ event }) => bulkEventIds.has(event.eventId)),
        events.length,
      );
      yield* sql`DROP TRIGGER reject_last_bulk_delivery`;

      yield* journal.markDeliveredMany(events);
      assert.lengthOf(
        (yield* journal.listUndelivered).filter(({ event }) => bulkEventIds.has(event.eventId)),
        0,
      );

      yield* sql`
        CREATE TRIGGER reject_last_bulk_removal
        BEFORE DELETE ON provider_transcript_journal
        WHEN OLD.event_id = 'journal-bulk-500'
        BEGIN
          SELECT RAISE(ABORT, 'injected bulk removal failure');
        END
      `;
      const removal = yield* Effect.exit(journal.removeMany(events));
      assert.isTrue(Exit.isFailure(removal));
      assert.lengthOf(yield* journal.list, initialEntries.length + events.length);
      yield* sql`DROP TRIGGER reject_last_bulk_removal`;

      yield* journal.removeMany(events);
      assert.lengthOf(yield* journal.list, initialEntries.length);
    }),
  );

  it.effect("keeps sealed batch membership immutable", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const journal = yield* ProviderTranscriptJournal;
      yield* sql`PRAGMA foreign_keys = OFF`;
      const first = {
        ...base,
        turnId: TurnId.make("journal-sealed-turn"),
        itemId: RuntimeItemId.make("journal-sealed-item"),
        type: "content.delta",
        eventId: EventId.make("journal-sealed-1"),
        createdAt: "2026-08-26T00:00:00.000Z",
        payload: { streamKind: "assistant_text", delta: "one" },
      } as const satisfies ProviderRuntimeEvent;
      const second = {
        ...first,
        eventId: EventId.make("journal-sealed-2"),
        createdAt: "2026-08-26T00:00:00.001Z",
        payload: { ...first.payload, delta: "two" },
      } as const satisfies ProviderRuntimeEvent;
      yield* journal.append(first);
      yield* journal.append(second);

      yield* journal.sealBatches([{ batchId: "batch-one", sourceEvents: [first, second] }]);
      yield* journal.sealBatches([{ batchId: "batch-two", sourceEvents: [first] }]);

      const sealed = (yield* journal.list).filter(({ event }) =>
        event.eventId.startsWith("journal-sealed-"),
      );
      assert.deepStrictEqual(
        sealed.map(({ batchId }) => batchId),
        ["batch-one", "batch-one"],
      );
    }),
  );
});
