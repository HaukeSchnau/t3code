import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  EnvironmentId,
  IsoDateTime,
  MessageId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** Follow-ups: work worth doing later, kept by one home environment per space (patches/follow-ups.md). */
export const FollowUpId = TrimmedNonEmptyString.pipe(Schema.brand("FollowUpId"));
export type FollowUpId = typeof FollowUpId.Type;

export const FollowUpStatus = Schema.Literals(["open", "picked_up", "done", "dropped", "merged"]);
export type FollowUpStatus = typeof FollowUpStatus.Type;

export const FollowUpThreadRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type FollowUpThreadRef = typeof FollowUpThreadRef.Type;

/** Where a follow-up came from. T3 sets it, so it points at the real thread and message. */
export const FollowUpOrigin = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messageId: Schema.NullOr(MessageId),
  quote: Schema.NullOr(Schema.String),
  threadTitle: Schema.NullOr(Schema.String),
});
export type FollowUpOrigin = typeof FollowUpOrigin.Type;

export const FollowUpLinkTarget = Schema.Union([
  Schema.Struct({ type: Schema.Literal("followUp"), followUpId: FollowUpId }),
  Schema.Struct({
    type: Schema.Literal("thread"),
    environmentId: EnvironmentId,
    threadId: ThreadId,
  }),
]);
export type FollowUpLinkTarget = typeof FollowUpLinkTarget.Type;

export const FollowUpLink = Schema.Struct({
  /** A word for how the two relate, such as "blocks", "came from" or "same as". */
  kind: TrimmedNonEmptyString,
  target: FollowUpLinkTarget,
});
export type FollowUpLink = typeof FollowUpLink.Type;

export const FollowUpActor = Schema.Struct({
  kind: Schema.Literals(["agent", "user", "gardener"]),
  thread: Schema.NullOr(FollowUpThreadRef),
});
export type FollowUpActor = typeof FollowUpActor.Type;

export const FollowUpFields = Schema.Record(Schema.String, Schema.Json);
export type FollowUpFields = typeof FollowUpFields.Type;

export const FollowUp = Schema.Struct({
  id: FollowUpId,
  title: Schema.String,
  body: Schema.String,
  status: FollowUpStatus,
  dueAt: Schema.NullOr(IsoDateTime),
  /** A plain-language moment, such as "once the M1 is back", that the nightly pass checks. */
  condition: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
  links: Schema.Array(FollowUpLink),
  type: Schema.NullOr(Schema.String),
  fields: FollowUpFields,
  origin: Schema.NullOr(FollowUpOrigin),
  pickedUpThread: Schema.NullOr(FollowUpThreadRef),
  result: Schema.NullOr(Schema.String),
  mergedInto: Schema.NullOr(FollowUpId),
  /** Set when its date arrived and it came back to the inbox; a later date clears it. */
  returnedAt: Schema.NullOr(IsoDateTime),
  createdBy: FollowUpActor,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
});
export type FollowUp = typeof FollowUp.Type;

export const FollowUpTypeField = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.String,
});
export type FollowUpTypeField = typeof FollowUpTypeField.Type;

/** A kind of follow-up an agent defined, with the fields it carries. */
export const FollowUpType = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.String,
  fields: Schema.Array(FollowUpTypeField),
  updatedAt: IsoDateTime,
});
export type FollowUpType = typeof FollowUpType.Type;

export const FollowUpChange = Schema.Struct({
  followUpId: FollowUpId,
  at: IsoDateTime,
  actor: FollowUpActor,
  summary: Schema.String,
});
export type FollowUpChange = typeof FollowUpChange.Type;

export const FollowUpGardenerRun = Schema.Struct({
  thread: FollowUpThreadRef,
  startedAt: IsoDateTime,
});
export type FollowUpGardenerRun = typeof FollowUpGardenerRun.Type;

export const FollowUpsSubscribeInput = Schema.Struct({
  /** Closed follow-ups too, newest first. Open ones always come. */
  includeClosed: Schema.optional(Schema.Boolean),
});
export type FollowUpsSubscribeInput = typeof FollowUpsSubscribeInput.Type;

export const FollowUpsSnapshot = Schema.Struct({
  followUps: Schema.Array(FollowUp),
  types: Schema.Array(FollowUpType),
  lastGardenerRun: Schema.NullOr(FollowUpGardenerRun),
});
export type FollowUpsSnapshot = typeof FollowUpsSnapshot.Type;

/** A create (no `id`) or a patch: only given fields change, and null clears a field. */
export const FollowUpSaveInput = Schema.Struct({
  id: Schema.optional(FollowUpId),
  title: Schema.optional(TrimmedNonEmptyString),
  body: Schema.optional(Schema.String),
  status: Schema.optional(FollowUpStatus),
  dueAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  condition: Schema.optional(Schema.NullOr(Schema.String)),
  tags: Schema.optional(Schema.Array(Schema.String)),
  links: Schema.optional(Schema.Array(FollowUpLink)),
  type: Schema.optional(Schema.NullOr(Schema.String)),
  fields: Schema.optional(FollowUpFields),
  result: Schema.optional(Schema.NullOr(Schema.String)),
  mergedInto: Schema.optional(Schema.NullOr(FollowUpId)),
  pickedUpThread: Schema.optional(Schema.NullOr(FollowUpThreadRef)),
  /** Only on create. */
  origin: Schema.optional(FollowUpOrigin),
});
export type FollowUpSaveInput = typeof FollowUpSaveInput.Type;

export const FollowUpHistoryInput = Schema.Struct({ id: FollowUpId });
export type FollowUpHistoryInput = typeof FollowUpHistoryInput.Type;

export const FollowUpHistory = Schema.Struct({ changes: Schema.Array(FollowUpChange) });
export type FollowUpHistory = typeof FollowUpHistory.Type;

export class FollowUpError extends Schema.TaggedError<FollowUpError>()("FollowUpError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const FOLLOW_UP_WS_METHODS = {
  subscribe: "followUps.subscribe",
  save: "followUps.save",
  history: "followUps.history",
} as const;

export const WsFollowUpsSubscribeRpc = Rpc.make(FOLLOW_UP_WS_METHODS.subscribe, {
  payload: FollowUpsSubscribeInput,
  success: FollowUpsSnapshot,
  error: Schema.Union([FollowUpError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsFollowUpsSaveRpc = Rpc.make(FOLLOW_UP_WS_METHODS.save, {
  payload: FollowUpSaveInput,
  success: FollowUp,
  error: Schema.Union([FollowUpError, EnvironmentAuthorizationError]),
});

export const WsFollowUpsHistoryRpc = Rpc.make(FOLLOW_UP_WS_METHODS.history, {
  payload: FollowUpHistoryInput,
  success: FollowUpHistory,
  error: Schema.Union([FollowUpError, EnvironmentAuthorizationError]),
});
