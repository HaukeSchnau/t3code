import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE orchestration_command_preprocessing ADD COLUMN setup_execution_key TEXT`;
  yield* sql`ALTER TABLE orchestration_command_preprocessing ADD COLUMN setup_script_digest TEXT`;
});
