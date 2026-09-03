import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("067_ProjectionMessageOrigins", (it) => {
  it.effect("adds typed origins to durable and queued messages", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 66 });
      yield* runMigrations({ toMigrationInclusive: 67 });

      const messageColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      const queuedColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_queued_messages)
      `;
      assert.ok(messageColumns.some((column) => column.name === "origin_json"));
      assert.ok(queuedColumns.some((column) => column.name === "origin_json"));
    }),
  );
});
