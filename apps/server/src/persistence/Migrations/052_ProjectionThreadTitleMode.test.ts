import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("052_ProjectionThreadTitleMode", (it) => {
  it.effect("adds nullable title provenance to projected threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 51 });
      yield* runMigrations({ toMigrationInclusive: 52 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const titleMode = columns.find((column) => column.name === "title_mode");
      assert.ok(titleMode);
    }),
  );
});
