import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS follow_ups (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      due_at TEXT,
      condition TEXT,
      tags_json TEXT NOT NULL,
      links_json TEXT NOT NULL,
      type TEXT,
      fields_json TEXT NOT NULL,
      origin_json TEXT,
      picked_up_thread_json TEXT,
      result TEXT,
      merged_into TEXT,
      returned_at TEXT,
      created_by_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_follow_ups_due
    ON follow_ups(due_at)
    WHERE status = 'open' AND due_at IS NOT NULL AND returned_at IS NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_follow_ups_closed
    ON follow_ups(closed_at)
    WHERE status NOT IN ('open', 'picked_up')
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS follow_up_types (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      fields_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS follow_up_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      follow_up_id TEXT NOT NULL,
      at TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      summary TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_follow_up_changes_follow_up
    ON follow_up_changes(follow_up_id, id)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS follow_up_gardener_runs (
      thread_json TEXT NOT NULL,
      started_at TEXT NOT NULL
    )
  `;
});
