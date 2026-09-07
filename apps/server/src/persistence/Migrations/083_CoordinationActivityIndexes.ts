import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX projection_thread_activities_coordination_idx
    ON projection_thread_activities(thread_id, created_at, activity_id)
    WHERE kind GLOB 'thread-orchestration.*'
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_coordination_items_idx
    ON orchestration_v2_projection_turn_items(thread_id, updated_at, turn_item_id)
    WHERE type = 'system_notice'
      AND json_type(payload_json, '$.coordinationActivity') = 'object'
  `;
});
