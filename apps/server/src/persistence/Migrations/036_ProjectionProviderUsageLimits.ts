import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_provider_usage_limits (
      provider_instance_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      usage_limits_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_provider_usage_limits_updated
    ON projection_provider_usage_limits(updated_at)
  `;

  yield* sql`
    WITH affected_usage_threads AS (
      SELECT thread_id
      FROM projection_thread_activities
      WHERE kind = 'account.rate-limits.updated'
      GROUP BY thread_id
    ),
    recalculated AS (
      SELECT
        threads.thread_id,
        COALESCE(
          (
            SELECT MAX(candidate_at)
            FROM (
              SELECT threads.created_at AS candidate_at
              UNION ALL
              SELECT threads.latest_user_message_at
              WHERE threads.latest_user_message_at IS NOT NULL
              UNION ALL
              SELECT MAX(messages.updated_at)
              FROM projection_thread_messages AS messages
              WHERE messages.thread_id = threads.thread_id
              UNION ALL
              SELECT MAX(activities.created_at)
              FROM projection_thread_activities AS activities
              WHERE activities.thread_id = threads.thread_id
                AND activities.kind != 'account.rate-limits.updated'
              UNION ALL
              SELECT MAX(sessions.updated_at)
              FROM projection_thread_sessions AS sessions
              WHERE sessions.thread_id = threads.thread_id
              UNION ALL
              SELECT MAX(plans.updated_at)
              FROM projection_thread_proposed_plans AS plans
              WHERE plans.thread_id = threads.thread_id
              UNION ALL
              SELECT MAX(queued.updated_at)
              FROM projection_thread_queued_messages AS queued
              WHERE queued.thread_id = threads.thread_id
              UNION ALL
              SELECT MAX(COALESCE(turns.completed_at, turns.started_at, turns.requested_at))
              FROM projection_turns AS turns
              WHERE turns.thread_id = threads.thread_id
            )
          ),
          threads.created_at
        ) AS updated_at
      FROM projection_threads AS threads
      INNER JOIN affected_usage_threads AS affected
        ON affected.thread_id = threads.thread_id
    )
    UPDATE projection_threads
    SET updated_at = (
      SELECT recalculated.updated_at
      FROM recalculated
      WHERE recalculated.thread_id = projection_threads.thread_id
    )
    WHERE thread_id IN (
      SELECT thread_id
      FROM affected_usage_threads
    )
  `;

  yield* sql`
    DELETE FROM projection_thread_activities
    WHERE kind = 'account.rate-limits.updated'
  `;
});
