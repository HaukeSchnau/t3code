import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_threads
    SET latest_turn_id = (
      SELECT turn.turn_id
      FROM projection_turns AS turn
      WHERE turn.thread_id = projection_threads.thread_id
        AND turn.turn_id IS NOT NULL
      ORDER BY
        COALESCE(turn.completed_at, turn.started_at, turn.requested_at) DESC,
        turn.requested_at DESC,
        turn.row_id DESC
      LIMIT 1
    )
    WHERE latest_turn_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM projection_turns AS turn
        WHERE turn.thread_id = projection_threads.thread_id
          AND turn.turn_id IS NOT NULL
      )
  `;
});
