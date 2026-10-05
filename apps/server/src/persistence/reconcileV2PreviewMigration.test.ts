import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import { reconcileV2PreviewMigration } from "./reconcileV2PreviewMigration.ts";

// The fork registers upstream's V2 migrations at 77-79. Its ids 53-56 belong to fork
// migrations, so upstream's preview ledger repair must never apply to a fork database.
describe("V2 preview upgrade on the fork ledger", () => {
  it.effect("leaves fork migrations 53-76 untouched and runs V2 at its fork ids", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 76 });

      assert.deepStrictEqual(yield* reconcileV2PreviewMigration(), []);
      assert.deepStrictEqual(yield* runMigrations(), [
        [77, "ProjectionThreadsAutoSettleDisabledAt"],
        [78, "OrchestrationV2"],
        [79, "RemoveRedundantProjectionIndexes"],
        [80, "AgentWatches"],
      ]);
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
