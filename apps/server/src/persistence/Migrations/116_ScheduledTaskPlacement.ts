import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Fork (patches/fleet-placement.md): "auto" starts each new thread where placement picks.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
  if (!columns.some((column) => column.name === "placement")) {
    yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN placement TEXT`;
  }
});
