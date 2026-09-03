import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE orchestration_command_preprocessing (
      command_id TEXT PRIMARY KEY,
      aggregate_kind TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      command_variant TEXT NOT NULL,
      envelope_fingerprint TEXT NOT NULL,
      deferred_preprocessing_completed INTEGER NOT NULL DEFAULT 0,
      thread_created INTEGER NOT NULL DEFAULT 0,
      workspace_prepared INTEGER NOT NULL DEFAULT 0,
      setup_claimed INTEGER NOT NULL DEFAULT 0,
      setup_completed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
