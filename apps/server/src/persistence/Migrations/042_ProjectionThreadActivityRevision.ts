import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Legacy rows deliberately start below every persisted orchestration event
  // sequence. The next append/update can therefore become the group maximum.
  yield* sql`
    ALTER TABLE projection_thread_activities
    ADD COLUMN activity_revision INTEGER NOT NULL DEFAULT 0
  `;

  yield* sql`
    ALTER TABLE projection_thread_activities
    ADD COLUMN payload_bytes INTEGER NOT NULL DEFAULT 0
  `;

  yield* sql`
    ALTER TABLE projection_thread_activities
    ADD COLUMN display_activity INTEGER NOT NULL DEFAULT 1
  `;

  yield* sql`
    UPDATE projection_thread_activities
    SET
      payload_bytes = length(CAST(payload_json AS BLOB)),
      display_activity = CASE
        WHEN kind IN (
          'tool.started', 'task.started', 'context-window.updated',
          'account.rate-limits.updated', 'subagent.thread', 'turn.plan.updated'
        ) OR summary = 'Checkpoint captured' OR (
          kind IN ('tool.updated', 'tool.completed')
          AND json_extract(payload_json, '$.detail') LIKE 'ExitPlanMode:%'
        ) THEN 0
        ELSE 1
      END
  `;

  yield* sql`
    DROP INDEX IF EXISTS idx_projection_thread_activities_thread_turn_sequence_created_id
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_turn_canonical_order
    ON projection_thread_activities(
      thread_id,
      turn_id,
      (sequence IS NULL),
      sequence,
      created_at,
      activity_id
    )
  `;
});
