import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS needs_you_cursor (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      sequence INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS needs_you_subjects (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      at TEXT NOT NULL,
      text TEXT,
      replaces TEXT,
      state TEXT NOT NULL,
      superseded INTEGER NOT NULL DEFAULT 0,
      held_until TEXT,
      version INTEGER,
      changed_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS needs_you_subjects_state ON needs_you_subjects (state, changed_at)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS needs_you_deliveries (
      subject_id TEXT NOT NULL,
      token TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      attempted_at TEXT,
      PRIMARY KEY (subject_id, token)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS needs_you_deliveries_open
    ON needs_you_deliveries (status) WHERE status IN ('pending', 'failed')
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS needs_you_checks (
      run_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      checked_at TEXT
    )
  `;
});
