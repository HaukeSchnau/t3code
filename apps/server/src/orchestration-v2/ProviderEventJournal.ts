import * as NodeCrypto from "node:crypto";

import {
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  toPersistenceSqlError,
} from "../persistence/Errors.ts";
import {
  ProviderAdapterV2Event,
  type ProviderAdapterV2Event as ProviderAdapterV2EventType,
} from "./ProviderAdapter.ts";

export const ProviderEventJournalContext = Schema.Struct({
  providerSessionId: ProviderSessionId,
  providerInstanceId: ProviderInstanceId,
  threadId: ThreadId,
});
export type ProviderEventJournalContext = typeof ProviderEventJournalContext.Type;

export interface ProviderEventJournalInput {
  readonly providerSessionId: ProviderSessionId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly event: ProviderAdapterV2EventType;
}

export interface ProviderEventJournalAccepted {
  readonly id: string;
  readonly sequence: number;
  readonly entityKey: string;
  readonly context: ProviderEventJournalContext;
}

export interface ProviderEventJournalRecord extends ProviderEventJournalAccepted {
  readonly event: ProviderAdapterV2EventType;
}

export interface ProviderEventJournalReadPendingInput {
  readonly throughSequence: number;
  readonly afterSequence?: number;
  readonly limit?: number;
}

export type ProviderEventJournalError = PersistenceSqlError | PersistenceDecodeError;
export type JournalError = ProviderEventJournalError;

export interface ProviderEventJournalShape {
  /** Persist a semantic provider snapshot before it reaches volatile ingestion. */
  readonly accept: (
    input: ProviderEventJournalInput,
  ) => Effect.Effect<boolean, ProviderEventJournalError>;
  /** Return live acceptance metadata associated with the original event object. */
  readonly getAccepted: (
    event: ProviderAdapterV2EventType,
  ) => ProviderEventJournalAccepted | undefined;
  readonly readPending: (
    input: ProviderEventJournalReadPendingInput,
  ) => Effect.Effect<ReadonlyArray<ProviderEventJournalRecord>, ProviderEventJournalError>;
  readonly latestSequence: Effect.Effect<number, ProviderEventJournalError>;
  readonly isPending: (id: string) => Effect.Effect<boolean, ProviderEventJournalError>;
  /** Retire this event and older snapshots for the same entity in the caller's transaction. */
  readonly commitAccepted: (id: string) => Effect.Effect<void, ProviderEventJournalError>;
}

export class ProviderEventJournal extends Context.Service<
  ProviderEventJournal,
  ProviderEventJournalShape
>()("t3/orchestration-v2/ProviderEventJournal") {}

const ProviderAdapterV2EventJson = Schema.toCodecJson(ProviderAdapterV2Event);

const ProviderEventJournalEnvelopeJson = Schema.Struct({
  context: ProviderEventJournalContext,
  event: ProviderAdapterV2EventJson,
});

const encodeEnvelope = Schema.encodeSync(ProviderEventJournalEnvelopeJson);
const encodeEventJson = Schema.encodeSync(ProviderAdapterV2EventJson);
const encodeContextJson = Schema.encodeSync(ProviderEventJournalContext);
const decodeContextJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProviderEventJournalContext),
);
const decodeEventJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProviderAdapterV2EventJson),
);

const JournalInsert = Schema.Struct({
  id: Schema.String,
  contextJson: Schema.String,
  entityKey: Schema.String,
  terminal: Schema.Number,
  eventJson: Schema.String,
});

const JournalInsertResult = Schema.Struct({
  id: Schema.String,
  sequence: Schema.Number,
  entityKey: Schema.String,
  contextJson: Schema.String,
});

const JournalRow = Schema.Struct({
  id: Schema.String,
  sequence: Schema.Number,
  entityKey: Schema.String,
  contextJson: Schema.String,
  eventJson: Schema.String,
});

const JournalLatestSequence = Schema.Struct({ sequence: Schema.Number });
const JournalPending = Schema.Struct({ pending: Schema.Number });

const journaledTypes = new Set<ProviderAdapterV2Event["type"]>([
  "app_thread.created",
  "provider_thread.updated",
  "provider_turn.updated",
  "node.updated",
  "subagent.updated",
  "message.updated",
  "turn_item.updated",
  "runtime_request.updated",
  "plan.updated",
]);

const encoder = new TextEncoder();

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function eventThreadId(event: ProviderAdapterV2Event): ThreadId | undefined {
  switch (event.type) {
    case "app_thread.created":
      return event.appThread.id;
    case "provider_thread.updated":
      return event.providerThread.appThreadId ?? undefined;
    case "provider_turn.updated":
    case "runtime_request.updated":
      return event.threadId;
    case "node.updated":
      return event.node.threadId;
    case "subagent.updated":
      return event.subagent.threadId;
    case "message.updated":
      return event.message.threadId;
    case "turn_item.updated":
      return event.turnItem.threadId;
    case "plan.updated":
      return event.plan.threadId;
    case "provider_session.updated":
    case "turn.terminal":
      return undefined;
  }
}

function eventEntityId(event: ProviderAdapterV2Event): string | undefined {
  switch (event.type) {
    case "app_thread.created":
      return event.appThread.id;
    case "provider_thread.updated":
      return event.providerThread.id;
    case "provider_turn.updated":
      return event.providerTurn.id;
    case "node.updated":
      return event.node.id;
    case "subagent.updated":
      return event.subagent.id;
    case "message.updated":
      return event.message.id;
    case "turn_item.updated":
      return event.turnItem.id;
    case "runtime_request.updated":
      return event.runtimeRequest.id;
    case "plan.updated":
      return event.plan.id;
    case "provider_session.updated":
    case "turn.terminal":
      return undefined;
  }
}

function eventEntityKey(context: ProviderEventJournalContext, event: ProviderAdapterV2Event): string {
  const entityId = eventEntityId(event);
  if (entityId === undefined) {
    throw new Error(`Provider event ${event.type} has no journal entity identity.`);
  }

  const runId =
    event.type === "message.updated"
      ? event.message.runId
      : event.type === "turn_item.updated"
        ? event.turnItem.runId
        : undefined;
  return [context.providerInstanceId, event.type, runId ?? "", entityId].join("\0");
}

function isTerminalSnapshot(event: ProviderAdapterV2Event): boolean {
  switch (event.type) {
    case "message.updated":
      return event.message.role === "assistant" && !event.message.streaming;
    case "turn_item.updated":
      return ["completed", "failed", "cancelled", "interrupted"].includes(event.turnItem.status);
    default:
      return false;
  }
}

function contextFor(input: ProviderEventJournalInput): ProviderEventJournalContext {
  return {
    providerSessionId: input.providerSessionId,
    providerInstanceId: input.providerInstanceId,
    threadId: eventThreadId(input.event) ?? input.threadId,
  };
}

function encodedEnvelope(input: ProviderEventJournalInput) {
  const context = contextFor(input);
  const envelope = encodeEnvelope({
    context,
    event: input.event,
  });
  const canonicalJson = stableJson(envelope);
  return {
    context,
    entityKey: eventEntityKey(context, input.event),
    terminal: isTerminalSnapshot(input.event) ? 1 : 0,
    eventJson: stableJson(encodeEventJson(input.event)),
    id: NodeCrypto.createHash("sha256").update(encoder.encode(canonicalJson)).digest("hex"),
  };
}

function decodeError(operation: string, cause: unknown): PersistenceDecodeError {
  return new PersistenceDecodeError({
    operation,
    issue: cause instanceof Error ? cause.message : "journal encoding or decoding failed",
    cause,
  });
}

const makeProviderEventJournal = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const acceptedByEvent = new WeakMap<ProviderAdapterV2Event, ProviderEventJournalAccepted>();

  const insert = SqlSchema.findOneOption({
    Request: JournalInsert,
    Result: JournalInsertResult,
    execute: (row) => sql`
      INSERT INTO provider_event_journal (id, context_json, entity_key, terminal, event_json)
      SELECT ${row.id}, ${row.contextJson}, ${row.entityKey}, ${row.terminal}, ${row.eventJson}
      WHERE ${row.terminal} = 1
        OR NOT EXISTS (
          SELECT 1
          FROM provider_event_journal
          WHERE entity_key = ${row.entityKey} AND terminal = 1
        )
      ON CONFLICT (id) DO NOTHING
      RETURNING id, sequence, entity_key AS "entityKey", context_json AS "contextJson"
    `,
  });

  const readRows = SqlSchema.findAll({
    Request: Schema.Struct({
      throughSequence: Schema.Number,
      afterSequence: Schema.Number,
      limit: Schema.Number,
    }),
    Result: JournalRow,
    execute: ({ throughSequence, afterSequence, limit }) => sql`
      SELECT id, sequence, entity_key AS "entityKey", context_json AS "contextJson",
             event_json AS "eventJson"
      FROM provider_event_journal
      WHERE delivered_at IS NULL
        AND event_json IS NOT NULL
        AND sequence > ${afterSequence}
        AND sequence <= ${throughSequence}
      ORDER BY sequence ASC
      LIMIT ${limit}
    `,
  });

  const latest = SqlSchema.findOne({
    Request: Schema.Void,
    Result: JournalLatestSequence,
    execute: () => sql`
      SELECT COALESCE(MAX(sequence), 0) AS sequence
      FROM provider_event_journal
    `,
  });

  const pending = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: Schema.String }),
    Result: JournalPending,
    execute: ({ id }) => sql`
      SELECT CASE WHEN delivered_at IS NULL AND event_json IS NOT NULL THEN 1 ELSE 0 END AS pending
      FROM provider_event_journal
      WHERE id = ${id}
    `,
  });

  const retire = SqlSchema.void({
    Request: Schema.Struct({ id: Schema.String }),
    execute: ({ id }) => sql`
      UPDATE provider_event_journal
      SET delivered_at = COALESCE(delivered_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          event_json = NULL
      WHERE delivered_at IS NULL
        AND event_json IS NOT NULL
        AND sequence <= (SELECT sequence FROM provider_event_journal WHERE id = ${id})
        AND entity_key = (SELECT entity_key FROM provider_event_journal WHERE id = ${id})
    `,
  });

  const accept: ProviderEventJournalShape["accept"] = (input) => {
    if (!journaledTypes.has(input.event.type)) return Effect.succeed(true);

    return Effect.try({
      try: () => encodedEnvelope(input),
      catch: (cause) => decodeError("encode", cause),
    }).pipe(
      Effect.flatMap((encoded) =>
        insert({
          id: encoded.id,
          contextJson: stableJson(encodeContextJson(encoded.context)),
          entityKey: encoded.entityKey,
          terminal: encoded.terminal,
          eventJson: encoded.eventJson,
        }).pipe(
          Effect.mapError(toPersistenceSqlError("accept")),
          Effect.map((inserted) => {
            if (Option.isNone(inserted)) return false;
            const metadata = {
              id: inserted.value.id,
              sequence: inserted.value.sequence,
              entityKey: inserted.value.entityKey,
              context: encoded.context,
            } satisfies ProviderEventJournalAccepted;
            acceptedByEvent.set(input.event, metadata);
            return true;
          }),
        ),
      ),
    );
  };

  const readPending: ProviderEventJournalShape["readPending"] = (input) =>
    readRows({
      throughSequence: input.throughSequence,
      afterSequence: input.afterSequence ?? 0,
      limit: input.limit ?? 500,
    }).pipe(
      Effect.mapError(toPersistenceSqlError("read")),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            const context = yield* decodeContextJson(row.contextJson).pipe(
              Effect.mapError((cause) =>
                PersistenceDecodeError.fromSchemaError("read", cause),
              ),
            );
            const event = yield* decodeEventJson(row.eventJson).pipe(
              Effect.mapError((cause) =>
                PersistenceDecodeError.fromSchemaError("read", cause),
              ),
            );
            return {
              id: row.id,
              sequence: row.sequence,
              entityKey: row.entityKey,
              context,
              event,
            } satisfies ProviderEventJournalRecord;
          }),
        ),
      ),
    );

  const latestSequence = latest(undefined).pipe(
    Effect.map((row) => row.sequence),
    Effect.mapError(toPersistenceSqlError("latest")),
  );

  const isPending: ProviderEventJournalShape["isPending"] = (id) =>
    pending({ id }).pipe(
      Effect.map((row) => Option.isSome(row) && row.value.pending === 1),
      Effect.mapError(toPersistenceSqlError("pending")),
    );

  const commitAccepted: ProviderEventJournalShape["commitAccepted"] = (id) =>
    retire({ id }).pipe(Effect.mapError(toPersistenceSqlError("commit")));

  return {
    accept,
    getAccepted: (event) => acceptedByEvent.get(event),
    readPending,
    latestSequence,
    isPending,
    commitAccepted,
  } satisfies ProviderEventJournalShape;
});

export const ProviderEventJournalLive = Layer.effect(
  ProviderEventJournal,
  makeProviderEventJournal,
);
