import {
  ChatAttachment,
  OrchestrationNotificationOrigin,
  NonNegativeInt,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
  type OrchestrationThreadHistoricalActivityGroup,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { ProjectionThreadMessage } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";

export const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
    origin: Schema.NullOr(Schema.fromJsonString(OrchestrationNotificationOrigin)),
  }),
);

export function mapProjectionMessageRow(
  row: Schema.Schema.Type<typeof ProjectionThreadMessageDbRowSchema>,
): OrchestrationMessage {
  const message = {
    id: row.messageId,
    role: row.role,
    text: row.text,
    turnId: row.turnId,
    streaming: row.isStreaming === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.attachments !== null) {
    Object.assign(message, { attachments: row.attachments });
  }
  if (row.origin !== null) Object.assign(message, { origin: row.origin });
  return message;
}

export const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);

export const ProjectionThreadHistoricalActivityGroupDbRowSchema = Schema.Struct({
  threadId: ProjectionThreadActivity.fields.threadId,
  turnId: TurnId,
  revision: NonNegativeInt,
  activityCount: NonNegativeInt,
  payloadBytes: NonNegativeInt,
  displayActivityCount: NonNegativeInt,
  firstActivityAt: ProjectionThreadActivity.fields.createdAt,
  lastActivityAt: ProjectionThreadActivity.fields.createdAt,
});

export function mapProjectionActivityRow(
  row: Schema.Schema.Type<typeof ProjectionThreadActivityDbRowSchema>,
): OrchestrationThreadActivity {
  return {
    id: row.activityId,
    tone: row.tone,
    kind: row.kind,
    summary: row.summary,
    payload: row.payload,
    turnId: row.turnId,
    ...(row.activityRevision > 0 ? { revision: row.activityRevision } : {}),
    ...(row.sequence !== null ? { sequence: row.sequence } : {}),
    createdAt: row.createdAt,
  };
}

export function groupProjectionHistoricalActivityRows(
  rows: ReadonlyArray<
    Schema.Schema.Type<typeof ProjectionThreadHistoricalActivityGroupDbRowSchema>
  >,
): OrchestrationThreadHistoricalActivityGroup[] {
  return rows.map((row) => ({
    turnId: row.turnId,
    revision: row.revision,
    activityCount: row.activityCount,
    payloadBytes: row.payloadBytes,
    displayActivityCount: row.displayActivityCount,
    firstActivityAt: row.firstActivityAt,
    lastActivityAt: row.lastActivityAt,
  }));
}
