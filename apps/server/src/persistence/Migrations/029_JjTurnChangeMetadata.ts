import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS vcs_turn_scopes (
      repo_root TEXT NOT NULL,
      cwd TEXT NOT NULL,
      vcs TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      state TEXT NOT NULL,
      start_operation_id TEXT,
      end_operation_id TEXT,
      boundary_change_id TEXT,
      fallback_change_id TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      last_reconciled_at TEXT,
      PRIMARY KEY (repo_root, thread_id, turn_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS vcs_turn_change_links (
      repo_root TEXT NOT NULL,
      change_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      role TEXT NOT NULL,
      first_operation_id TEXT,
      last_operation_id TEXT,
      first_commit_id TEXT,
      latest_commit_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      pruned_at TEXT,
      PRIMARY KEY (repo_root, change_id, thread_id, turn_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_vcs_turn_change_links_repo_change
    ON vcs_turn_change_links(repo_root, change_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_vcs_turn_change_links_thread_turn
    ON vcs_turn_change_links(thread_id, turn_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS vcs_external_turn_diffs (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      scope TEXT NOT NULL,
      unified_diff TEXT NOT NULL,
      files_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, turn_id, cwd, scope)
    )
  `;
});
