import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The fork's skill packs are gone, so their thread selections have no reader. Migration 68's
 * columns stay: v1 projection tables are legacy recovery data and keep every column they had.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE IF EXISTS skill_pack_thread_selections`;
});
