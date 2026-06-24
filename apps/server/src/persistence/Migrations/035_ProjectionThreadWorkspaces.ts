// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

interface LegacyThreadRow {
  readonly thread_id: string;
  readonly project_id: string;
  readonly worktree_path: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly workspace_root: string | null;
}

function legacyWorkspaceId(threadId: string): string {
  return `legacy-workspace:${threadId}`;
}

function legacyWorkspaceRootId(threadId: string): string {
  return `legacy-workspace-root:${threadId}`;
}

function displayNameForPath(path: string): string {
  const parsed = NodePath.basename(path.trim());
  return parsed.length > 0 ? parsed : path;
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "workspace_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN workspace_id TEXT
    `;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_workspaces (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      lifecycle TEXT NOT NULL,
      display_name TEXT NOT NULL,
      managed INTEGER NOT NULL,
      primary_root_id TEXT NOT NULL,
      created_for_thread_id TEXT,
      retention_policy TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      failure_detail TEXT,
      metadata_json TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_workspace_roots (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      role TEXT NOT NULL,
      source_path TEXT NOT NULL,
      checkout_path TEXT NOT NULL,
      vcs_kind TEXT NOT NULL,
      repository_root TEXT,
      base_revision TEXT,
      head_revision TEXT,
      metadata_json TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_workspaces_thread
    ON projection_thread_workspaces(created_for_thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_workspace_roots_workspace
    ON projection_thread_workspace_roots(workspace_id)
  `;

  const legacyThreads = yield* sql<LegacyThreadRow>`
    SELECT
      threads.thread_id,
      threads.project_id,
      threads.worktree_path,
      threads.created_at,
      threads.updated_at,
      projects.workspace_root
    FROM projection_threads AS threads
    LEFT JOIN projection_projects AS projects
      ON projects.project_id = threads.project_id
    WHERE threads.worktree_path IS NOT NULL
      AND TRIM(threads.worktree_path) <> ''
      AND threads.workspace_id IS NULL
  `;

  for (const thread of legacyThreads) {
    const worktreePath = thread.worktree_path;
    if (!worktreePath) {
      continue;
    }
    const workspaceId = legacyWorkspaceId(thread.thread_id);
    const rootId = legacyWorkspaceRootId(thread.thread_id);
    const metadataJson = JSON.stringify({ legacyBranchBacked: true });

    yield* sql`
      INSERT OR IGNORE INTO projection_thread_workspaces (
        id,
        kind,
        lifecycle,
        display_name,
        managed,
        primary_root_id,
        created_for_thread_id,
        retention_policy,
        created_at,
        updated_at,
        deleted_at,
        failure_detail,
        metadata_json
      ) VALUES (
        ${workspaceId},
        'git-detached',
        'active',
        ${displayNameForPath(worktreePath)},
        1,
        ${rootId},
        ${thread.thread_id},
        'explicit-delete',
        ${thread.created_at},
        ${thread.updated_at},
        NULL,
        NULL,
        ${metadataJson}
      )
    `;

    yield* sql`
      INSERT OR IGNORE INTO projection_thread_workspace_roots (
        id,
        workspace_id,
        project_id,
        role,
        source_path,
        checkout_path,
        vcs_kind,
        repository_root,
        base_revision,
        head_revision,
        metadata_json
      ) VALUES (
        ${rootId},
        ${workspaceId},
        ${thread.project_id},
        'primary',
        ${thread.workspace_root ?? worktreePath},
        ${worktreePath},
        'git',
        ${thread.workspace_root},
        NULL,
        NULL,
        ${metadataJson}
      )
    `;

    yield* sql`
      UPDATE projection_threads
      SET workspace_id = ${workspaceId}
      WHERE thread_id = ${thread.thread_id}
        AND workspace_id IS NULL
    `;
  }
});
