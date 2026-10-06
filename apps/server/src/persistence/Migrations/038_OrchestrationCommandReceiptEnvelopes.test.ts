import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(NodeSqliteClient.layerMemory());

layer("038_OrchestrationCommandReceiptEnvelopes", (it) => {
  it.effect("preserves legacy receipts as explicitly unverifiable rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id,
          aggregate_kind,
          aggregate_id,
          accepted_at,
          result_sequence,
          status,
          error
        )
        VALUES (
          'cmd-legacy-receipt',
          'thread',
          'thread-legacy-receipt',
          '2026-01-01T00:00:00.000Z',
          42,
          'accepted',
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 38 });

      const rows = yield* sql<{
        readonly result_sequence: number;
        readonly command_variant: string | null;
        readonly envelope_fingerprint: string | null;
      }>`
        SELECT result_sequence, command_variant, envelope_fingerprint
        FROM orchestration_command_receipts
        WHERE command_id = 'cmd-legacy-receipt'
      `;
      assert.deepStrictEqual(rows, [
        { result_sequence: 42, command_variant: null, envelope_fingerprint: null },
      ]);
    }),
  );
});
