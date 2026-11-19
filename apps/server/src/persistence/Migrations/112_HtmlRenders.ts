import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Pages shown before this migration are not indexed: finding them would scan every turn item.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS html_renders (
      render_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      title TEXT NOT NULL,
      first_published_at TEXT NOT NULL,
      latest_attachment_id TEXT NOT NULL,
      latest_published_at TEXT NOT NULL,
      version_count INTEGER NOT NULL,
      seen_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS html_renders_latest_idx
    ON html_renders(latest_published_at, render_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS html_renders_thread_latest_idx
    ON html_renders(thread_id, latest_published_at, render_id)
  `;
});
