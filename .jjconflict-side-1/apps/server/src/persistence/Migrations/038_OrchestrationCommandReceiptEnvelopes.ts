import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Existing receipts cannot be reconstructed into complete command envelopes.
  // Null therefore marks a legacy receipt that must fail closed on replay.
  yield* sql`
    ALTER TABLE orchestration_command_receipts
    ADD COLUMN command_variant TEXT
  `;

  yield* sql`
    ALTER TABLE orchestration_command_receipts
    ADD COLUMN envelope_fingerprint TEXT
  `;
});
