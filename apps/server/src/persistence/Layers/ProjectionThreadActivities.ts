import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { NonNegativeInt } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { PersistenceSqlError, toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";

import {
  DeleteProjectionThreadActivitiesInput,
  ListProjectionThreadActivitiesInput,
  ProjectionThreadActivity,
  ProjectionThreadActivityRepository,
  type ProjectionThreadActivityRepositoryShape,
} from "../Services/ProjectionThreadActivities.ts";

const utf8Encoder = new TextEncoder();

const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);

const mapActivityRows = (
  rows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionThreadActivityDbRowSchema>>,
): ReadonlyArray<ProjectionThreadActivity> =>
  rows.map((row) => ({
    activityId: row.activityId,
    threadId: row.threadId,
    turnId: row.turnId,
    tone: row.tone,
    kind: row.kind,
    summary: row.summary,
    payload: row.payload,
    activityRevision: row.activityRevision,
    ...(row.sequence !== null ? { sequence: row.sequence } : {}),
    createdAt: row.createdAt,
  }));

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) => {
    if (Schema.isSchemaError(cause)) {
      return toPersistenceDecodeError(decodeOperation)(cause);
    }
    const reason =
      typeof cause === "object" && cause !== null && "reason" in cause
        ? (cause.reason as unknown)
        : null;
    const nativeCause =
      typeof reason === "object" && reason !== null && "cause" in reason
        ? (reason.cause as unknown)
        : null;
    const nativeMessage =
      nativeCause instanceof Error
        ? nativeCause.message
        : typeof nativeCause === "object" && nativeCause !== null && "message" in nativeCause
          ? String(nativeCause.message)
          : null;
    if (nativeMessage?.includes("projection_thread_activities membership is immutable")) {
      return new PersistenceSqlError({
        operation: sqlOperation,
        detail: nativeMessage,
        cause,
      });
    }
    return toPersistenceSqlError(sqlOperation)(cause);
  };
}

function activityIsDisplayActivity(row: {
  readonly kind: string;
  readonly summary: string;
  readonly payload: unknown;
}): boolean {
  if (
    row.kind === "tool.started" ||
    row.kind === "task.started" ||
    row.kind === "context-window.updated" ||
    row.kind === "account.rate-limits.updated" ||
    row.kind === "subagent.thread" ||
    row.kind === "turn.plan.updated" ||
    row.summary === "Checkpoint captured"
  ) {
    return false;
  }
  if (row.kind !== "tool.updated" && row.kind !== "tool.completed") {
    return true;
  }
  const payload =
    typeof row.payload === "object" && row.payload !== null
      ? (row.payload as Record<string, unknown>)
      : null;
  return typeof payload?.detail !== "string" || !payload.detail.startsWith("ExitPlanMode:");
}

const makeProjectionThreadActivityRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadActivityRow = SqlSchema.void({
    Request: ProjectionThreadActivity,
    execute: (row) => {
      const payloadJson = JSON.stringify(row.payload);
      return sql`
            INSERT INTO projection_thread_activities (
              activity_id,
              thread_id,
              turn_id,
              tone,
              kind,
              summary,
              payload_json,
              activity_revision,
              payload_bytes,
              display_activity,
              sequence,
              created_at
            )
            VALUES (
              ${row.activityId},
              ${row.threadId},
              ${row.turnId},
              ${row.tone},
              ${row.kind},
              ${row.summary},
              ${payloadJson},
              ${row.activityRevision},
              ${utf8Encoder.encode(payloadJson).byteLength},
              ${activityIsDisplayActivity(row) ? 1 : 0},
              ${row.sequence ?? null},
              ${row.createdAt}
            )
            ON CONFLICT (activity_id)
            DO UPDATE SET
              thread_id = excluded.thread_id,
              turn_id = excluded.turn_id,
              tone = excluded.tone,
              kind = excluded.kind,
              summary = excluded.summary,
              payload_json = excluded.payload_json,
              activity_revision = excluded.activity_revision,
              payload_bytes = excluded.payload_bytes,
              display_activity = excluded.display_activity,
              sequence = excluded.sequence,
              created_at = excluded.created_at
          `;
    },
  });

  const listProjectionThreadActivityRows = SqlSchema.findAll({
    Request: ListProjectionThreadActivitiesInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          activity_revision AS "activityRevision",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
        ORDER BY
          (sequence IS NULL) ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listUserInputLifecycleActivityRows = SqlSchema.findAll({
    Request: ListProjectionThreadActivitiesInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          activity_revision AS "activityRevision",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND kind IN (
            'user-input.requested',
            'user-input.resolved',
            'provider.user-input.respond.failed'
          )
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const deleteProjectionThreadActivityRows = SqlSchema.void({
    Request: DeleteProjectionThreadActivitiesInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_activities
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadActivityRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadActivityRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadActivityRepository.upsert:query",
          "ProjectionThreadActivityRepository.upsert:encodeRequest",
        ),
      ),
    );

  const listByThreadId: ProjectionThreadActivityRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadActivityRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadActivityRepository.listByThreadId:query",
          "ProjectionThreadActivityRepository.listByThreadId:decodeRows",
        ),
      ),
      Effect.map(mapActivityRows),
    );

  const listUserInputLifecycleByThreadId: ProjectionThreadActivityRepositoryShape["listUserInputLifecycleByThreadId"] =
    (input) =>
      listUserInputLifecycleActivityRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionThreadActivityRepository.listUserInputLifecycleByThreadId:query",
            "ProjectionThreadActivityRepository.listUserInputLifecycleByThreadId:decodeRows",
          ),
        ),
        Effect.map(mapActivityRows),
      );

  const deleteByThreadId: ProjectionThreadActivityRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadActivityRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadActivityRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    listByThreadId,
    listUserInputLifecycleByThreadId,
    deleteByThreadId,
  } satisfies ProjectionThreadActivityRepositoryShape;
});

export const ProjectionThreadActivityRepositoryLive = Layer.effect(
  ProjectionThreadActivityRepository,
  makeProjectionThreadActivityRepository,
);
