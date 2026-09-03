import {
  defaultInstanceIdForDriver,
  EventId,
  NonNegativeInt,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProviderTranscriptJournal,
  type ProviderTranscriptJournalShape,
} from "../Services/ProviderTranscriptJournal.ts";

const JournalIdentity = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  eventId: EventId,
});

const JournalAppend = Schema.Struct({
  ...JournalIdentity.fields,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  itemId: Schema.NullOr(RuntimeItemId),
  guardsItemCompletion: NonNegativeInt,
  completesItem: NonNegativeInt,
  eventJson: Schema.String,
});

const JournalRow = Schema.Struct({
  sequence: NonNegativeInt,
  batchId: Schema.NullOr(Schema.String),
  eventJson: Schema.String,
});

const BULK_IDENTITY_CHUNK_SIZE = 500;

const decodeJournalRow = (row: typeof JournalRow.Type) => ({
  sequence: row.sequence,
  batchId: row.batchId,
  // This is an internal write-ahead record produced only after adapters have
  // already built a typed runtime event. Avoid re-decoding through schemas
  // that normalize transcript whitespace: the journal must be byte-exact.
  event: JSON.parse(row.eventJson) as ProviderRuntimeEvent,
});

const identity = (event: ProviderRuntimeEvent) => ({
  providerInstanceId: event.providerInstanceId ?? defaultInstanceIdForDriver(event.provider),
  eventId: event.eventId,
});

function groupEventIdsByProviderInstance(
  events: ReadonlyArray<ProviderRuntimeEvent>,
): Map<ProviderInstanceId, Array<EventId>> {
  const groups = new Map<ProviderInstanceId, Array<EventId>>();
  for (const event of events) {
    const eventIdentity = identity(event);
    const eventIds = groups.get(eventIdentity.providerInstanceId) ?? [];
    eventIds.push(eventIdentity.eventId);
    groups.set(eventIdentity.providerInstanceId, eventIds);
  }
  return groups;
}

function chunksOf<A>(values: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> {
  const chunks: Array<ReadonlyArray<A>> = [];
  for (let index = 0; index < values.length; index += BULK_IDENTITY_CHUNK_SIZE) {
    chunks.push(values.slice(index, index + BULK_IDENTITY_CHUNK_SIZE));
  }
  return chunks;
}

const scope = (event: ProviderRuntimeEvent) => ({
  ...identity(event),
  threadId: ThreadId.make(event.threadId),
  turnId: event.turnId === undefined ? null : TurnId.make(event.turnId),
  itemId: event.itemId === undefined ? null : RuntimeItemId.make(event.itemId),
});

const itemScopeKey = (event: ProviderRuntimeEvent) => {
  const eventScope = scope(event);
  return eventScope.itemId === null
    ? null
    : `${eventScope.providerInstanceId}\0${eventScope.threadId}\0${eventScope.turnId ?? ""}\0${eventScope.itemId}`;
};

const ItemScope = Schema.Struct({
  scopeKey: Schema.String,
  providerInstanceId: ProviderInstanceId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  itemId: RuntimeItemId,
});

const CompletedItem = Schema.Struct({
  ...ItemScope.fields,
  completedAt: Schema.String,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const appendRow = SqlSchema.findOneOption({
    Request: JournalAppend,
    Result: Schema.Struct({ eventId: EventId }),
    execute: (row) => sql`
      INSERT INTO provider_transcript_journal (
        provider_instance_id,
        event_id,
        thread_id,
        turn_id,
        item_id,
        completes_item,
        event_json
      ) SELECT
        ${row.providerInstanceId},
        ${row.eventId},
        ${row.threadId},
        ${row.turnId},
        ${row.itemId},
        ${row.completesItem},
        ${row.eventJson}
      WHERE ${row.guardsItemCompletion} = 0
        OR (
          NOT EXISTS (
            SELECT 1
            FROM provider_transcript_completed_items
            WHERE scope_key = ${`${row.providerInstanceId}\0${row.threadId}\0${row.turnId ?? ""}\0${row.itemId ?? ""}`}
          )
          AND NOT EXISTS (
            SELECT 1
            FROM provider_transcript_journal
            WHERE provider_instance_id = ${row.providerInstanceId}
              AND thread_id = ${row.threadId}
              AND turn_id IS ${row.turnId}
              AND item_id IS ${row.itemId}
              AND completes_item = 1
          )
        )
      ON CONFLICT (provider_instance_id, event_id) DO NOTHING
      RETURNING event_id AS "eventId"
    `,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: JournalRow,
    execute: () => sql`
      SELECT sequence, batch_id AS "batchId", event_json AS "eventJson"
      FROM provider_transcript_journal
      ORDER BY sequence ASC
    `,
  });

  const listUndeliveredRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: JournalRow,
    execute: () => sql`
      SELECT sequence, batch_id AS "batchId", event_json AS "eventJson"
      FROM provider_transcript_journal
      WHERE delivered = 0
      ORDER BY sequence ASC
    `,
  });

  const markDeliveredRow = SqlSchema.void({
    Request: JournalIdentity,
    execute: (row) => sql`
      UPDATE provider_transcript_journal
      SET delivered = 1
      WHERE provider_instance_id = ${row.providerInstanceId}
        AND event_id = ${row.eventId}
    `,
  });

  const removeRow = SqlSchema.void({
    Request: JournalIdentity,
    execute: (row) => sql`
      DELETE FROM provider_transcript_journal
      WHERE provider_instance_id = ${row.providerInstanceId}
        AND event_id = ${row.eventId}
    `,
  });

  const removeItemRows = SqlSchema.void({
    Request: ItemScope,
    execute: (row) => sql`
      DELETE FROM provider_transcript_journal
      WHERE provider_instance_id = ${row.providerInstanceId}
        AND thread_id = ${row.threadId}
        AND turn_id IS ${row.turnId}
        AND item_id = ${row.itemId}
    `,
  });

  const findCompletedItem = SqlSchema.findOneOption({
    Request: Schema.Struct({ scopeKey: Schema.String }),
    Result: Schema.Struct({ scopeKey: Schema.String }),
    execute: (row) => sql`
      SELECT scope_key AS "scopeKey"
      FROM provider_transcript_completed_items
      WHERE scope_key = ${row.scopeKey}
    `,
  });

  const markCompletedItem = SqlSchema.void({
    Request: CompletedItem,
    execute: (row) => sql`
      INSERT INTO provider_transcript_completed_items (
        scope_key,
        provider_instance_id,
        thread_id,
        turn_id,
        item_id,
        completed_at
      ) VALUES (
        ${row.scopeKey},
        ${row.providerInstanceId},
        ${row.threadId},
        ${row.turnId},
        ${row.itemId},
        ${row.completedAt}
      )
      ON CONFLICT (scope_key) DO NOTHING
    `,
  });

  const append: ProviderTranscriptJournalShape["append"] = (event) => {
    const guardsItemCompletion =
      event.itemId !== undefined &&
      (event.type === "content.delta" ||
        (event.type === "item.completed" && event.payload.itemType === "assistant_message"));
    return appendRow({
      ...scope(event),
      guardsItemCompletion: guardsItemCompletion ? 1 : 0,
      completesItem:
        event.type === "item.completed" && event.payload.itemType === "assistant_message" ? 1 : 0,
      eventJson: JSON.stringify(event),
    }).pipe(
      Effect.mapError(toPersistenceSqlError("ProviderTranscriptJournal.append")),
      Effect.map(Option.isSome),
    );
  };
  const list: ProviderTranscriptJournalShape["list"] = listRows(undefined).pipe(
    Effect.mapError(toPersistenceSqlError("ProviderTranscriptJournal.list")),
    Effect.map((rows) => rows.map(decodeJournalRow)),
  );
  const listUndelivered: ProviderTranscriptJournalShape["listUndelivered"] = listUndeliveredRows(
    undefined,
  ).pipe(
    Effect.mapError(toPersistenceSqlError("ProviderTranscriptJournal.listUndelivered")),
    Effect.map((rows) => rows.map(decodeJournalRow)),
  );
  const sealBatches: ProviderTranscriptJournalShape["sealBatches"] = (batches) => {
    if (batches.length === 0) return Effect.void;
    return sql
      .withTransaction(
        Effect.forEach(
          batches,
          ({ batchId, sourceEvents }) =>
            Effect.forEach(
              groupEventIdsByProviderInstance(sourceEvents),
              ([providerInstanceId, eventIds]) =>
                Effect.forEach(
                  chunksOf(eventIds),
                  (chunk) => sql`
                    UPDATE provider_transcript_journal
                    SET batch_id = ${batchId}
                    WHERE provider_instance_id = ${providerInstanceId}
                      AND event_id IN ${sql.in(chunk)}
                      AND batch_id IS NULL
                  `,
                  { concurrency: 1, discard: true },
                ),
              { concurrency: 1, discard: true },
            ),
          { concurrency: 1, discard: true },
        ),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("ProviderTranscriptJournal.sealBatches")));
  };
  const markDelivered: ProviderTranscriptJournalShape["markDelivered"] = (event) =>
    markDeliveredRow(identity(event)).pipe(
      Effect.mapError(toPersistenceSqlError("ProviderTranscriptJournal.markDelivered")),
    );
  const markDeliveredMany: ProviderTranscriptJournalShape["markDeliveredMany"] = (events) => {
    if (events.length === 0) return Effect.void;
    return sql
      .withTransaction(
        Effect.forEach(
          groupEventIdsByProviderInstance(events),
          ([providerInstanceId, eventIds]) =>
            Effect.forEach(
              chunksOf(eventIds),
              (chunk) => sql`
                UPDATE provider_transcript_journal
                SET delivered = 1
                WHERE provider_instance_id = ${providerInstanceId}
                  AND event_id IN ${sql.in(chunk)}
              `,
              { concurrency: 1, discard: true },
            ),
          { concurrency: 1, discard: true },
        ),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("ProviderTranscriptJournal.markDeliveredMany")));
  };
  const remove: ProviderTranscriptJournalShape["remove"] = (event) =>
    removeRow(identity(event)).pipe(
      Effect.mapError(toPersistenceSqlError("ProviderTranscriptJournal.remove")),
    );
  const removeMany: ProviderTranscriptJournalShape["removeMany"] = (events) => {
    if (events.length === 0) return Effect.void;
    return sql
      .withTransaction(
        Effect.forEach(
          groupEventIdsByProviderInstance(events),
          ([providerInstanceId, eventIds]) =>
            Effect.forEach(
              chunksOf(eventIds),
              (chunk) => sql`
                DELETE FROM provider_transcript_journal
                WHERE provider_instance_id = ${providerInstanceId}
                  AND event_id IN ${sql.in(chunk)}
              `,
              { concurrency: 1, discard: true },
            ),
          { concurrency: 1, discard: true },
        ),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("ProviderTranscriptJournal.removeMany")));
  };
  const removeItem: ProviderTranscriptJournalShape["removeItem"] = (event) => {
    const eventScope = scope(event);
    return eventScope.itemId === null
      ? remove(event)
      : removeItemRows({
          ...eventScope,
          scopeKey: itemScopeKey(event)!,
          itemId: eventScope.itemId,
        }).pipe(Effect.mapError(toPersistenceSqlError("ProviderTranscriptJournal.removeItem")));
  };
  const isItemCompleted: ProviderTranscriptJournalShape["isItemCompleted"] = (event) => {
    const scopeKey = itemScopeKey(event);
    return scopeKey === null
      ? Effect.succeed(false)
      : findCompletedItem({ scopeKey }).pipe(
          Effect.map(Option.isSome),
          Effect.mapError(toPersistenceSqlError("ProviderTranscriptJournal.isItemCompleted")),
        );
  };
  const markItemCompleted: ProviderTranscriptJournalShape["markItemCompleted"] = (event) => {
    const eventScope = scope(event);
    const scopeKey = itemScopeKey(event);
    return eventScope.itemId === null || scopeKey === null
      ? Effect.void
      : markCompletedItem({
          ...eventScope,
          scopeKey,
          itemId: eventScope.itemId,
          completedAt: event.createdAt,
        }).pipe(
          Effect.mapError(toPersistenceSqlError("ProviderTranscriptJournal.markItemCompleted")),
        );
  };

  return {
    append,
    list,
    listUndelivered,
    sealBatches,
    markDelivered,
    markDeliveredMany,
    remove,
    removeMany,
    removeItem,
    isItemCompleted,
    markItemCompleted,
  } satisfies ProviderTranscriptJournalShape;
});

export const ProviderTranscriptJournalLive = Layer.effect(ProviderTranscriptJournal, make);
