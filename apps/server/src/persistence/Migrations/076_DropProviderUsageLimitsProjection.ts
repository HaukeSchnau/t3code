import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Drops the fork's provider usage-limit projection. Usage limits now live on
 * provider snapshots, so the `provider` aggregate's events and command
 * bookkeeping, the projection table and its projector cursor have no reader,
 * and the event store could no longer decode those events. Usage snapshots
 * that older fork versions appended as thread activities go too: no projector
 * filters them out anymore.
 *
 * Older builds query the dropped table unconditionally, so rolling back past
 * this migration needs a database backup.
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
