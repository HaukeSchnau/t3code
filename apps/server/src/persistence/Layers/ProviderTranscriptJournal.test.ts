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
});
