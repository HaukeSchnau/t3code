import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Crash-durable write-ahead storage for semantic provider snapshots.
 * Identity rows remain after delivery so retries cannot create a second event.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE provider_event_journal (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      context_json TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      terminal INTEGER NOT NULL DEFAULT 0,
      event_json TEXT,
      delivered_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX provider_event_journal_pending_sequence_idx
    ON provider_event_journal(sequence)
    WHERE delivered_at IS NULL AND event_json IS NOT NULL
  `;

  yield* sql`
    CREATE INDEX provider_event_journal_entity_sequence_idx
    ON provider_event_journal(entity_key, sequence)
  `;
});
