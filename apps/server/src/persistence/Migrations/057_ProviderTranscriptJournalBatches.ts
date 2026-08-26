import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(provider_transcript_journal)
  `;

  if (!columns.some((column) => column.name === "batch_id")) {
    yield* sql`
      ALTER TABLE provider_transcript_journal
      ADD COLUMN batch_id TEXT
    `;
  }
});
