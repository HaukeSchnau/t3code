import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Placement counts this host's active runs for every load report a linked peer reads.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_runs_active_status_idx
    ON orchestration_v2_projection_runs(status)
    WHERE status IN ('preparing', 'starting', 'running', 'waiting')
  `;
});
