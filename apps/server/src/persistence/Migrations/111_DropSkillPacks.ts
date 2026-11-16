import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The fork's skill packs (migrations 68 and 81) are gone, so their selections and project
 * defaults have no reader. Older builds query these, so rolling back needs a backup.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE IF EXISTS skill_pack_thread_selections`;
  yield* sql`ALTER TABLE projection_projects DROP COLUMN default_skill_pack_ids_json`;
  yield* sql`ALTER TABLE projection_threads DROP COLUMN skill_scope_json`;
});
