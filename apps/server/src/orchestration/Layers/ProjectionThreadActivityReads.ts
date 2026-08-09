import {
  NonNegativeInt,
  OrchestrationTurnActivitiesSnapshot,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  isPersistenceError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import type { ProjectionSnapshotQueryShape } from "../Services/ProjectionSnapshotQuery.ts";
import {
  groupProjectionHistoricalActivityRows,
  mapProjectionActivityRow,
  ProjectionThreadActivityDbRowSchema,
  ProjectionThreadHistoricalActivityGroupDbRowSchema,
} from "./ProjectionReadMappings.ts";

const ThreadIdLookupInput = Schema.Struct({ threadId: ThreadId });
const ThreadTurnIdLookupInput = Schema.Struct({ threadId: ThreadId, turnId: TurnId });
const ProjectionThreadIdLookupRowSchema = Schema.Struct({ threadId: ThreadId });
const ProjectionThreadActivityRevisionDbRowSchema = Schema.Struct({
  revision: NonNegativeInt,
  payloadBytes: NonNegativeInt,
});
const decodeTurnActivitiesSnapshot = Schema.decodeUnknownEffect(
  OrchestrationTurnActivitiesSnapshot,
);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

export function makeProjectionThreadActivityReads(input: {
  readonly sql: SqlClient.SqlClient;
  readonly getSnapshotSequence: ProjectionSnapshotQueryShape["getSnapshotSequence"];
  readonly getActiveThread: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<unknown>, ProjectionRepositoryError>;
}) {
  const listHotThreadActivityRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) => input.sql`
      WITH latest_context AS (
        SELECT activity_id
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND kind = 'context-window.updated'
        ORDER BY
          (sequence IS NULL) DESC,
          sequence DESC,
          created_at DESC,
          activity_id DESC
        LIMIT 1
      )
      SELECT
        activity.activity_id AS "activityId",
        activity.thread_id AS "threadId",
        activity.turn_id AS "turnId",
        activity.tone,
        activity.kind,
        activity.summary,
        activity.payload_json AS "payload",
        activity.activity_revision AS "activityRevision",
        activity.sequence,
        activity.created_at AS "createdAt"
      FROM projection_thread_activities AS activity
      INNER JOIN projection_threads AS thread
        ON thread.thread_id = activity.thread_id
      LEFT JOIN projection_thread_sessions AS session
        ON session.thread_id = activity.thread_id
      WHERE activity.thread_id = ${threadId}
        AND (
          (
            activity.turn_id IS NULL
            AND (
              activity.kind <> 'context-window.updated'
              OR activity.activity_id = (SELECT activity_id FROM latest_context)
            )
          )
          OR activity.turn_id = thread.latest_turn_id
          OR activity.turn_id = session.active_turn_id
          OR activity.kind IN ('subagent.thread', 'turn.plan.updated')
        )
      ORDER BY
        (activity.sequence IS NULL) ASC,
        activity.sequence ASC,
        activity.created_at ASC,
        activity.activity_id ASC
    `,
  });

  const listHistoricalThreadActivityGroupRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadHistoricalActivityGroupDbRowSchema,
    execute: ({ threadId }) => input.sql`
      WITH historical AS (
        SELECT
          activity.thread_id,
          activity.turn_id,
          activity.activity_revision,
          activity.payload_bytes,
          activity.display_activity
        FROM projection_thread_activities AS activity
        INNER JOIN projection_threads AS thread
          ON thread.thread_id = activity.thread_id
        LEFT JOIN projection_thread_sessions AS session
          ON session.thread_id = activity.thread_id
        WHERE activity.thread_id = ${threadId}
          AND activity.turn_id IS NOT NULL
          AND activity.kind NOT IN ('subagent.thread', 'turn.plan.updated')
          AND (thread.latest_turn_id IS NULL OR activity.turn_id <> thread.latest_turn_id)
          AND (session.active_turn_id IS NULL OR activity.turn_id <> session.active_turn_id)
      )
      SELECT
        historical.thread_id AS "threadId",
        historical.turn_id AS "turnId",
        MAX(historical.activity_revision) AS "revision",
        COUNT(*) AS "activityCount",
        SUM(historical.payload_bytes) AS "payloadBytes",
        SUM(historical.display_activity) AS "displayActivityCount",
        COALESCE((
          SELECT first.created_at
          FROM projection_thread_activities AS first
          WHERE first.thread_id = historical.thread_id
            AND first.turn_id = historical.turn_id
            AND first.kind NOT IN ('subagent.thread', 'turn.plan.updated')
            AND first.display_activity = 1
          ORDER BY
            (first.sequence IS NULL) ASC,
            first.sequence ASC,
            first.created_at ASC,
            first.activity_id ASC
          LIMIT 1
        ), (
          SELECT fallback_first.created_at
          FROM projection_thread_activities AS fallback_first
          WHERE fallback_first.thread_id = historical.thread_id
            AND fallback_first.turn_id = historical.turn_id
            AND fallback_first.kind NOT IN ('subagent.thread', 'turn.plan.updated')
          ORDER BY
            (fallback_first.sequence IS NULL) ASC,
            fallback_first.sequence ASC,
            fallback_first.created_at ASC,
            fallback_first.activity_id ASC
          LIMIT 1
        )) AS "firstActivityAt",
        COALESCE((
          SELECT last.created_at
          FROM projection_thread_activities AS last
          WHERE last.thread_id = historical.thread_id
            AND last.turn_id = historical.turn_id
            AND last.kind NOT IN ('subagent.thread', 'turn.plan.updated')
            AND last.display_activity = 1
          ORDER BY
            (last.sequence IS NULL) DESC,
            last.sequence DESC,
            last.created_at DESC,
            last.activity_id DESC
          LIMIT 1
        ), (
          SELECT fallback_last.created_at
          FROM projection_thread_activities AS fallback_last
          WHERE fallback_last.thread_id = historical.thread_id
            AND fallback_last.turn_id = historical.turn_id
            AND fallback_last.kind NOT IN ('subagent.thread', 'turn.plan.updated')
          ORDER BY
            (fallback_last.sequence IS NULL) DESC,
            fallback_last.sequence DESC,
            fallback_last.created_at DESC,
            fallback_last.activity_id DESC
          LIMIT 1
        )) AS "lastActivityAt"
      FROM historical
      GROUP BY historical.thread_id, historical.turn_id
      ORDER BY "firstActivityAt" ASC, historical.turn_id ASC
    `,
  });

  const listThreadActivityRowsByTurn = SqlSchema.findAll({
    Request: ThreadTurnIdLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId, turnId }) => input.sql`
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
        AND turn_id = ${turnId}
        AND kind NOT IN ('subagent.thread', 'turn.plan.updated')
      ORDER BY
        (sequence IS NULL) ASC,
        sequence ASC,
        created_at ASC,
        activity_id ASC
    `,
  });

  const getTurnByThread = SqlSchema.findOneOption({
    Request: ThreadTurnIdLookupInput,
    Result: ProjectionThreadIdLookupRowSchema,
    execute: ({ threadId, turnId }) => input.sql`
      SELECT thread_id AS "threadId"
      FROM projection_turns
      WHERE thread_id = ${threadId}
        AND turn_id = ${turnId}
      LIMIT 1
    `,
  });

  const getThreadActivityRevisionByTurn = SqlSchema.findOne({
    Request: ThreadTurnIdLookupInput,
    Result: ProjectionThreadActivityRevisionDbRowSchema,
    execute: ({ threadId, turnId }) => input.sql`
      SELECT
        COALESCE(MAX(activity_revision), 0) AS "revision",
        COALESCE(SUM(payload_bytes), 0) AS "payloadBytes"
      FROM projection_thread_activities
      WHERE thread_id = ${threadId}
        AND turn_id = ${turnId}
        AND kind NOT IN ('subagent.thread', 'turn.plan.updated')
    `,
  });

  const getCompactThreadActivities = Effect.fn(
    "ProjectionThreadActivityReads.getCompactThreadActivities",
  )(function* (threadId: ThreadId) {
    const [activityRows, historicalRows] = yield* Effect.all([
      listHotThreadActivityRowsByThread({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadDetailById:listActivities:query",
            "ProjectionSnapshotQuery.getThreadDetailById:listActivities:decodeRows",
          ),
        ),
      ),
      listHistoricalThreadActivityGroupRowsByThread({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadDetailById:listHistoricalActivities:query",
            "ProjectionSnapshotQuery.getThreadDetailById:listHistoricalActivities:decodeRows",
          ),
        ),
      ),
    ]);
    return {
      activities: activityRows.map(mapProjectionActivityRow),
      historicalActivityGroups: groupProjectionHistoricalActivityRows(historicalRows),
    };
  });

  const getTurnActivitiesSnapshot: ProjectionSnapshotQueryShape["getTurnActivitiesSnapshot"] = (
    threadId,
    turnId,
  ) =>
    input.sql
      .withTransaction(
        Effect.gen(function* () {
          const [thread, turn, activityRows, activityRevision] = yield* Effect.all([
            input.getActiveThread(threadId),
            getTurnByThread({ threadId, turnId }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getTurnActivitiesSnapshot:getTurn:query",
                  "ProjectionSnapshotQuery.getTurnActivitiesSnapshot:getTurn:decodeRow",
                ),
              ),
            ),
            listThreadActivityRowsByTurn({ threadId, turnId }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getTurnActivitiesSnapshot:listActivities:query",
                  "ProjectionSnapshotQuery.getTurnActivitiesSnapshot:listActivities:decodeRows",
                ),
              ),
            ),
            getThreadActivityRevisionByTurn({ threadId, turnId }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getTurnActivitiesSnapshot:getRevision:query",
                  "ProjectionSnapshotQuery.getTurnActivitiesSnapshot:getRevision:decodeRow",
                ),
              ),
            ),
          ]);
          if (Option.isNone(thread) || Option.isNone(turn)) {
            return Option.none<OrchestrationTurnActivitiesSnapshot>();
          }
          const { snapshotSequence } = yield* input.getSnapshotSequence();
          const snapshot = yield* decodeTurnActivitiesSnapshot({
            snapshotSequence,
            threadId,
            turnId,
            revision: activityRevision.revision,
            payloadBytes: activityRevision.payloadBytes,
            activities: activityRows.map(mapProjectionActivityRow),
          }).pipe(
            Effect.mapError(
              toPersistenceDecodeError(
                "ProjectionSnapshotQuery.getTurnActivitiesSnapshot:decodeSnapshot",
              ),
            ),
          );
          return Option.some(snapshot);
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isPersistenceError(error)
            ? error
            : toPersistenceSqlError(
                "ProjectionSnapshotQuery.getTurnActivitiesSnapshot:transaction",
              )(error),
        ),
      );

  return { getCompactThreadActivities, getTurnActivitiesSnapshot };
}
