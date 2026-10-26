import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Usage limits now live on provider snapshots, so the fork's `provider` aggregate, its projection
 * and old usage-snapshot thread activities have no reader, and the event store can no longer
 * decode those events. Older builds query the dropped table, so rolling back needs a backup.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The `provider` aggregate only ever held `provider.usage-limits-updated`.
  yield* sql`DELETE FROM orchestration_events WHERE aggregate_kind = 'provider'`;
  yield* sql`
    DELETE FROM orchestration_events
    WHERE event_type = 'thread.activity-appended'
      AND json_extract(payload_json, '$.activity.kind') = 'account.rate-limits.updated'
  `;
  yield* sql`DELETE FROM orchestration_command_receipts WHERE aggregate_kind = 'provider'`;
  yield* sql`DELETE FROM orchestration_command_preprocessing WHERE aggregate_kind = 'provider'`;
  yield* sql`DELETE FROM projection_state WHERE projector = 'projection.provider-usage-limits'`;
  yield* sql`DROP TABLE IF EXISTS projection_provider_usage_limits`;
});
