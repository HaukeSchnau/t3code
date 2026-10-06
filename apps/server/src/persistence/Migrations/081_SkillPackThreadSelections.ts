import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Fork: per-thread skill pack selections (patches/skill-packs.md). The v1
 * projection kept them in `projection_threads.skill_scope_json`, which v2 no
 * longer projects; copy them so threads keep their packs.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS skill_pack_thread_selections (
      thread_id TEXT PRIMARY KEY,
      pack_ids_json TEXT NOT NULL,
      applied_pack_ids_json TEXT,
      issue TEXT,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    INSERT OR IGNORE INTO skill_pack_thread_selections (
      thread_id,
      pack_ids_json,
      applied_pack_ids_json,
      issue,
      updated_at
    )
    SELECT
      thread_id,
      json_extract(skill_scope_json, '$.packIds'),
      CASE
        WHEN json_extract(skill_scope_json, '$.appliedVersion')
          = json_extract(skill_scope_json, '$.version')
        THEN json_extract(skill_scope_json, '$.packIds')
      END,
      CASE
        WHEN json_extract(skill_scope_json, '$.state') = 'degraded'
        THEN json_extract(skill_scope_json, '$.issue')
      END,
      updated_at
    FROM projection_threads
    WHERE deleted_at IS NULL
      AND json_valid(skill_scope_json)
      AND json_type(skill_scope_json, '$.packIds') = 'array'
  `;
});
