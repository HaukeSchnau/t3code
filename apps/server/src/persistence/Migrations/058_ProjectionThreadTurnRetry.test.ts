import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("058_ProjectionThreadTurnRetry", (it) => {
  it.effect("adds overload classification and durable retry state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 57 });
      yield* runMigrations({ toMigrationInclusive: 58 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_sessions)
      `;
      assert.ok(columns.some((column) => column.name === "last_error_class"));
      assert.ok(columns.some((column) => column.name === "turn_retry_json"));
    }),
  );
});
