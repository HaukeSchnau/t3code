import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("060_ProjectionThreadRecentActivityIndex", (it) => {
  it.effect("indexes bounded recent activity reads in reverse order", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 59 });
      yield* runMigrations({ toMigrationInclusive: 60 });

      const columns = yield* sql<{
        readonly name: string | null;
        readonly desc: number;
      }>`
        PRAGMA index_xinfo('idx_projection_thread_activities_thread_recent')
      `;
      assert.deepStrictEqual(
        columns
          .filter((column) => column.name !== null)
          .map((column) => [column.name, column.desc]),
        [
          ["thread_id", 0],
          ["sequence", 1],
          ["created_at", 1],
          ["activity_id", 1],
        ],
      );

      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT activity_id
        FROM projection_thread_activities
        WHERE thread_id = 'thread-1'
        ORDER BY sequence DESC, created_at DESC, activity_id DESC
        LIMIT 500
      `;
      assert.ok(
        plan.some((row) => row.detail.includes("idx_projection_thread_activities_thread_recent")),
      );
      assert.ok(!plan.some((row) => row.detail.includes("USE TEMP B-TREE FOR ORDER BY")));
    }),
  );
});
