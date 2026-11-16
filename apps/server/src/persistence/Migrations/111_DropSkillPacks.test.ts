import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("111_DropSkillPacks", (it) => {
  it.effect("drops skill pack selections and both skill pack columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 110 });
      yield* sql`
        INSERT INTO skill_pack_thread_selections (thread_id, pack_ids_json, updated_at)
        VALUES ('thread-1', '["web-craft"]', '2026-11-16T00:00:00.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 111 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'skill_pack_thread_selections'
      `;
      const projectColumns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_projects')
      `;
      const threadColumns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('projection_threads')
      `;
      assert.deepStrictEqual(tables, []);
      assert.notInclude(
        projectColumns.map((column) => column.name),
        "default_skill_pack_ids_json",
      );
      assert.notInclude(
        threadColumns.map((column) => column.name),
        "skill_scope_json",
      );
    }),
  );
});
