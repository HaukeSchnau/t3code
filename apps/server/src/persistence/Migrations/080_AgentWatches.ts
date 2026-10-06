import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_watches (
      watch_id TEXT PRIMARY KEY,
      watcher_thread_id TEXT NOT NULL,
      label TEXT,
      source_json TEXT NOT NULL,
      state TEXT NOT NULL,
      close_reason TEXT,
      final_json TEXT,
      deadline_at TEXT,
      generation INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      closed_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_agent_watches_watcher
    ON agent_watches(watcher_thread_id, created_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_agent_watches_unclosed
    ON agent_watches(state)
    WHERE state <> 'closed'
  `;
});
