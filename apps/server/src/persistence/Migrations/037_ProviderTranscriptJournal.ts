import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_transcript_journal (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_instance_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      item_id TEXT,
      completes_item INTEGER NOT NULL DEFAULT 0,
      delivered INTEGER NOT NULL DEFAULT 0,
      event_json TEXT NOT NULL,
      UNIQUE (provider_instance_id, event_id),
      FOREIGN KEY (thread_id) REFERENCES projection_threads(thread_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_transcript_journal_scope
    ON provider_transcript_journal(provider_instance_id, thread_id, turn_id, item_id, sequence)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_transcript_journal_thread
    ON provider_transcript_journal(thread_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_transcript_completed_items (
      scope_key TEXT PRIMARY KEY,
      provider_instance_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      item_id TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES projection_threads(thread_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_transcript_completed_items_thread
    ON provider_transcript_completed_items(thread_id)
  `;
});
