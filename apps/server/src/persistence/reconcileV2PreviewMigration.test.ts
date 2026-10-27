import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, ORCHESTRATION_V2_MIGRATION_ID, runMigrations } from "./Migrations.ts";
import { reconcileV2PreviewMigration } from "./reconcileV2PreviewMigration.ts";

// Fork ids 53 and 54 hold fork migrations, never OrchestrationV2 (patches/fork-workflow.md), so
// upstream's preview ledger repair can never apply to a fork database.
describe("V2 preview upgrade on the fork ledger", () => {
  it.effect("is a no-op before and after the fork runs V2", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: ORCHESTRATION_V2_MIGRATION_ID - 1 });
      assert.deepStrictEqual(yield* reconcileV2PreviewMigration(), []);

      yield* runMigrations();
      assert.deepStrictEqual(yield* reconcileV2PreviewMigration(), []);

      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        history.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
