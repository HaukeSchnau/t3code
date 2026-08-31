import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("059_ProjectionThreadActivityKindIndex", (it) => {
  it.effect("indexes relationship activity reads by kind and creation order", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 58 });
      yield* runMigrations({ toMigrationInclusive: 59 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA index_info('idx_projection_thread_activities_kind_created_id')
      `;
      assert.deepStrictEqual(
        columns.map((column) => column.name),
        ["kind", "created_at", "activity_id"],
      );

      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT activity_id
        FROM projection_thread_activities
        WHERE kind = 'thread-orchestration.relationship'
        ORDER BY created_at ASC, activity_id ASC
      `;
      assert.ok(
        plan.some((row) => row.detail.includes("idx_projection_thread_activities_kind_created_id")),
      );
      assert.ok(!plan.some((row) => row.detail.includes("USE TEMP B-TREE FOR ORDER BY")));
    }),
  );
});
