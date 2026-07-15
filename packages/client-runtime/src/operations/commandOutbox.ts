import {
  ClientOrchestrationCommand,
  EnvironmentId,
  IsoDateTime,
  PositiveInt,
  type ClientOrchestrationCommand as ClientOrchestrationCommandType,
  type EnvironmentId as EnvironmentIdType,
  type IsoDateTime as IsoDateTimeType,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

const DURABLE_COMMAND_TYPES = ["thread.turn.start", "thread.message.queue"] as const;
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type DurableCommandType = (typeof DURABLE_COMMAND_TYPES)[number];
export type DurableClientCommand = Extract<
  ClientOrchestrationCommandType,
  { readonly type: DurableCommandType }
>;

export function isDurableClientCommand(
  command: ClientOrchestrationCommandType,
): command is DurableClientCommand {
  return DURABLE_COMMAND_TYPES.some((type) => type === command.type);
}

/**
 * The deliberately small command allowlist that may cross the durable replay
 * boundary. Adding a command here is a protocol-safety decision, not a generic
 * RPC convenience.
 */
export const DurableClientCommand = ClientOrchestrationCommand.pipe(
  Schema.refine(isDurableClientCommand, {
    message: "Only audited thread message commands may be stored in the durable outbox",
  }),
);

/** Canonical UTC timestamps keep persisted retry comparisons deterministic. */
export const CommandOutboxTimestamp = IsoDateTime.check(
  Schema.isPattern(CANONICAL_UTC_TIMESTAMP),
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    return (
      (parsed._tag === "Some" && DateTime.formatIso(parsed.value) === value) ||
      "Expected a canonical UTC timestamp"
    );
  }),
);

export const DurableCommandDeliveryPlan = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  environmentId: EnvironmentId,
  enqueuedAt: CommandOutboxTimestamp,
  command: DurableClientCommand,
});
export type DurableCommandDeliveryPlan = typeof DurableCommandDeliveryPlan.Type;

export const CommandDeliveryFailureClassification = Schema.Literals([
  "transient",
  "ambiguous",
  "permanent",
]);
export type CommandDeliveryFailureClassification = typeof CommandDeliveryFailureClassification.Type;

export const CommandDeliveryFailure = Schema.Struct({
  classification: CommandDeliveryFailureClassification,
  message: Schema.String,
  failedAt: CommandOutboxTimestamp,
});
export type CommandDeliveryFailure = typeof CommandDeliveryFailure.Type;

const PendingCommandState = Schema.TaggedStruct("Pending", {});

const DeliveringCommandState = Schema.TaggedStruct("Delivering", {
  attempt: PositiveInt,
  startedAt: CommandOutboxTimestamp,
});

const RetryingCommandState = Schema.TaggedStruct("Retrying", {
  attempt: PositiveInt,
  retryNotBefore: CommandOutboxTimestamp,
  failure: CommandDeliveryFailure,
});

const RejectedCommandState = Schema.TaggedStruct("Rejected", {
  attempt: PositiveInt,
  failure: CommandDeliveryFailure,
});

export const DurableCommandState = Schema.Union([
  PendingCommandState,
  DeliveringCommandState,
  RetryingCommandState,
  RejectedCommandState,
]);
export type DurableCommandState = typeof DurableCommandState.Type;

export const DurableCommandOutboxEntry = Schema.Struct({
  plan: DurableCommandDeliveryPlan,
  state: DurableCommandState,
});
export type DurableCommandOutboxEntry = typeof DurableCommandOutboxEntry.Type;

export const DurableCommandOutboxDocument = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  entries: Schema.Array(DurableCommandOutboxEntry),
}).check(
  Schema.makeFilter((document) => {
    const identities = new Set(document.entries.map((entry) => entry.plan.command.commandId));
    return identities.size === document.entries.length || "Command identities must be unique";
  }),
);
export type DurableCommandOutboxDocument = typeof DurableCommandOutboxDocument.Type;

function deepFreeze<A>(value: A): A {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

const decodeDeliveryPlan = Schema.decodeUnknownSync(DurableCommandDeliveryPlan);
const decodeOutboxDocument = Schema.decodeUnknownSync(DurableCommandOutboxDocument);
const encodeOutboxDocument = Schema.encodeUnknownSync(DurableCommandOutboxDocument);

export function makeDurableCommandDeliveryPlan(input: {
  readonly environmentId: EnvironmentIdType;
  readonly enqueuedAt: IsoDateTimeType;
  readonly command: DurableClientCommand;
}): DurableCommandDeliveryPlan {
  return deepFreeze(
    decodeDeliveryPlan({
      schemaVersion: 1,
      ...input,
    }),
  );
}

export function decodeDurableCommandOutboxDocument(value: unknown): DurableCommandOutboxDocument {
  return deepFreeze(decodeOutboxDocument(value));
}

export function encodeDurableCommandOutboxDocument(
  document: DurableCommandOutboxDocument,
): unknown {
  return encodeOutboxDocument(document);
}

export const EMPTY_DURABLE_COMMAND_OUTBOX_DOCUMENT = deepFreeze(
  decodeOutboxDocument({ schemaVersion: 1, entries: [] }),
);
