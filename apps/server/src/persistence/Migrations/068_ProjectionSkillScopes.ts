import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN default_skill_pack_ids_json TEXT NOT NULL DEFAULT '[]'
  `;
  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN skill_scope_json TEXT
  `;
});
