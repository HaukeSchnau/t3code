import {
  NonNegativeInt,
  IsoDateTime,
  OrchestrationSession,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import {
  type ProjectionRestartSafetyState,
  type ProjectionSnapshotQueryShape,
  type ProjectionThreadResultContext,
} from "../Services/ProjectionSnapshotQuery.ts";
import {
  mapProjectionMessageRow,
  ProjectionThreadMessageDbRowSchema,
} from "./ProjectionReadMappings.ts";

const ProjectionRestartSafetyRowSchema = Schema.Struct({
  threadId: ThreadId,
  sessionStatus: Schema.NullOr(OrchestrationSession.fields.status),
  sessionProviderName: Schema.NullOr(Schema.String),
  sessionProviderInstanceId: Schema.NullOr(ProviderInstanceId),
  sessionRuntimeMode: Schema.NullOr(RuntimeMode),
  sessionActiveTurnId: Schema.NullOr(TurnId),
  sessionLastError: Schema.NullOr(Schema.String),
  sessionUpdatedAt: Schema.NullOr(IsoDateTime),
  latestTurnId: Schema.NullOr(TurnId),
  latestTurnState: Schema.NullOr(Schema.String),
  latestTurnUpdatedAt: Schema.NullOr(IsoDateTime),
  queuedMessageCount: NonNegativeInt,
  pendingApprovalCount: NonNegativeInt,
  pendingUserInputCount: NonNegativeInt,
  undeliveredTranscriptEventCount: NonNegativeInt,
});

const ProjectionThreadCountRowSchema = Schema.Struct({ count: NonNegativeInt });
const ThreadIdLookupInput = Schema.Struct({ threadId: ThreadId });
const decodeRestartSafetySession = Schema.decodeUnknownEffect(OrchestrationSession);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

export function makeProjectionOperationalReads(input: {
  readonly sql: SqlClient.SqlClient;
  readonly getThreadShellById: ProjectionSnapshotQueryShape["getThreadShellById"];
  readonly getProjectShellById: ProjectionSnapshotQueryShape["getProjectShellById"];
}) {
  const listRestartSafetyRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionRestartSafetyRowSchema,
    execute: () => input.sql`
      SELECT
        threads.thread_id AS "threadId",
        sessions.status AS "sessionStatus",
        sessions.provider_name AS "sessionProviderName",
        sessions.provider_instance_id AS "sessionProviderInstanceId",
        sessions.runtime_mode AS "sessionRuntimeMode",
        sessions.active_turn_id AS "sessionActiveTurnId",
        sessions.last_error AS "sessionLastError",
        sessions.updated_at AS "sessionUpdatedAt",
        turns.turn_id AS "latestTurnId",
        turns.state AS "latestTurnState",
        COALESCE(turns.completed_at, turns.started_at, turns.requested_at) AS "latestTurnUpdatedAt",
        COALESCE(queued.message_count, 0) AS "queuedMessageCount",
        threads.pending_approval_count AS "pendingApprovalCount",
        threads.pending_user_input_count AS "pendingUserInputCount",
        COALESCE(journal.event_count, 0) AS "undeliveredTranscriptEventCount"
      FROM projection_threads AS threads
      LEFT JOIN projection_thread_sessions AS sessions
        ON sessions.thread_id = threads.thread_id
      LEFT JOIN projection_turns AS turns
        ON turns.thread_id = threads.thread_id
       AND turns.turn_id = threads.latest_turn_id
      LEFT JOIN (
        SELECT thread_id, COUNT(*) AS message_count
        FROM projection_thread_queued_messages
        GROUP BY thread_id
      ) AS queued ON queued.thread_id = threads.thread_id
      LEFT JOIN (
        SELECT thread_id, COUNT(*) AS event_count
        FROM provider_transcript_journal
        WHERE delivered = 0
        GROUP BY thread_id
      ) AS journal ON journal.thread_id = threads.thread_id
      WHERE threads.deleted_at IS NULL
        AND (
          sessions.active_turn_id IS NOT NULL
          OR sessions.status IN ('starting', 'running')
          OR turns.state = 'running'
          OR COALESCE(queued.message_count, 0) > 0
          OR threads.pending_approval_count > 0
          OR threads.pending_user_input_count > 0
          OR COALESCE(journal.event_count, 0) > 0
        )
      ORDER BY threads.thread_id ASC
    `,
  });

  const getLatestThreadMessageRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) => input.sql`
      SELECT
        message_id AS "messageId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        role,
        text,
        attachments_json AS "attachments",
        origin_json AS "origin",
        is_streaming AS "isStreaming",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
      ORDER BY created_at DESC, message_id DESC
      LIMIT 1
    `,
  });

  const getLatestAssistantThreadMessageRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) => input.sql`
      SELECT
        message_id AS "messageId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        role,
        text,
        attachments_json AS "attachments",
        origin_json AS "origin",
        is_streaming AS "isStreaming",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
        AND role = 'assistant'
      ORDER BY created_at DESC, message_id DESC
      LIMIT 1
    `,
  });

  const readThreadQueuedMessageCountByThread = SqlSchema.findOne({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadCountRowSchema,
    execute: ({ threadId }) => input.sql`
      SELECT COUNT(*) AS "count"
      FROM projection_thread_queued_messages
      WHERE thread_id = ${threadId}
    `,
  });

  const readThreadActivityCountByThread = SqlSchema.findOne({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadCountRowSchema,
    execute: ({ threadId }) => input.sql`
      SELECT COUNT(*) AS "count"
      FROM projection_thread_activities
      WHERE thread_id = ${threadId}
    `,
  });

  const getRestartSafetyState: NonNullable<
    ProjectionSnapshotQueryShape["getRestartSafetyState"]
  > = () =>
    Effect.gen(function* () {
      const rows = yield* listRestartSafetyRows(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getRestartSafetyState:query",
            "ProjectionSnapshotQuery.getRestartSafetyState:decodeRows",
          ),
        ),
      );
      const threads = yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const session =
            row.sessionStatus === null ||
            row.sessionRuntimeMode === null ||
            row.sessionUpdatedAt === null
              ? null
              : yield* decodeRestartSafetySession({
                  threadId: row.threadId,
                  status: row.sessionStatus,
                  providerName: row.sessionProviderName,
                  ...(row.sessionProviderInstanceId === null
                    ? {}
                    : { providerInstanceId: row.sessionProviderInstanceId }),
                  runtimeMode: row.sessionRuntimeMode,
                  activeTurnId: row.sessionActiveTurnId,
                  lastError: row.sessionLastError,
                  updatedAt: row.sessionUpdatedAt,
                }).pipe(
                  Effect.mapError(
                    toPersistenceDecodeError(
                      "ProjectionSnapshotQuery.getRestartSafetyState:decodeSession",
                    ),
                  ),
                );
          return {
            threadId: row.threadId,
            session,
            latestTurnId: row.latestTurnId,
            latestTurnState: row.latestTurnState,
            latestTurnUpdatedAt: row.latestTurnUpdatedAt,
            queuedMessageCount: row.queuedMessageCount,
            pendingApprovalCount: row.pendingApprovalCount,
            pendingUserInputCount: row.pendingUserInputCount,
            undeliveredTranscriptEventCount: row.undeliveredTranscriptEventCount,
          };
        }),
      );
      return { threads } satisfies ProjectionRestartSafetyState;
    });

  const getThreadResultContextById: ProjectionSnapshotQueryShape["getThreadResultContextById"] = (
    threadId,
  ) =>
    Effect.gen(function* () {
      const [
        threadOption,
        latestMessageRow,
        latestAssistantMessageRow,
        queuedMessageCountRow,
        activityCountRow,
      ] = yield* Effect.all([
        input.getThreadShellById(threadId),
        getLatestThreadMessageRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadResultContextById:getLatestMessage:query",
              "ProjectionSnapshotQuery.getThreadResultContextById:getLatestMessage:decodeRow",
            ),
          ),
        ),
        getLatestAssistantThreadMessageRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadResultContextById:getLatestAssistantMessage:query",
              "ProjectionSnapshotQuery.getThreadResultContextById:getLatestAssistantMessage:decodeRow",
            ),
          ),
        ),
        readThreadQueuedMessageCountByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadResultContextById:queuedCount:query",
              "ProjectionSnapshotQuery.getThreadResultContextById:queuedCount:decodeRow",
            ),
          ),
        ),
        readThreadActivityCountByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadResultContextById:activityCount:query",
              "ProjectionSnapshotQuery.getThreadResultContextById:activityCount:decodeRow",
            ),
          ),
        ),
      ]);

      if (Option.isNone(threadOption)) {
        return Option.none<ProjectionThreadResultContext>();
      }
      const projectOption = yield* input.getProjectShellById(threadOption.value.projectId);
      if (Option.isNone(projectOption)) {
        return Option.none<ProjectionThreadResultContext>();
      }
      return Option.some({
        thread: threadOption.value,
        project: projectOption.value,
        latestMessage: Option.isSome(latestMessageRow)
          ? mapProjectionMessageRow(latestMessageRow.value)
          : null,
        latestAssistantMessage: Option.isSome(latestAssistantMessageRow)
          ? mapProjectionMessageRow(latestAssistantMessageRow.value)
          : null,
        queuedMessageCount: queuedMessageCountRow.count,
        activityCount: activityCountRow.count,
      });
    });

  return { getRestartSafetyState, getThreadResultContextById };
}
