import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(NodeSqliteClient.layerMemory());
const now = "2026-09-20T10:00:00.000Z";

layer("081_SkillPackThreadSelections", (it) => {
  it.effect("carries v1 thread skill scopes into the fork table", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 79 });

      const insertThread = (threadId: string, scope: string | null, deletedAt: string | null) =>
        sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
            created_at, updated_at, deleted_at, skill_scope_json
          )
          VALUES (
            ${threadId}, 'project', 'Thread', '{"instanceId":"codex","model":"gpt-5.4"}',
            'full-access', 'default', ${now}, ${now}, ${deletedAt}, ${scope}
          )
        `;
      yield* insertThread(
        "applied",
        '{"version":2,"appliedVersion":2,"packIds":["web-craft"],"state":"ready"}',
        null,
      );
      yield* insertThread(
        "pending",
        '{"version":3,"appliedVersion":2,"packIds":["web-craft","effect"],"state":"pending"}',
        null,
      );
      yield* insertThread(
        "degraded",
        '{"version":1,"appliedVersion":1,"packIds":["effect"],"state":"degraded","issue":"Missing skills: effect-docs"}',
        null,
      );
      yield* insertThread(
        "deleted",
        '{"version":1,"appliedVersion":1,"packIds":["effect"],"state":"ready"}',
        now,
      );
      yield* insertThread("core-only", null, null);

      yield* runMigrations({ toMigrationInclusive: 81 });

      const rows = yield* sql<{
        readonly thread_id: string;
        readonly pack_ids_json: string;
        readonly applied_pack_ids_json: string | null;
        readonly issue: string | null;
      }>`
        SELECT thread_id, pack_ids_json, applied_pack_ids_json, issue
        FROM skill_pack_thread_selections
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(rows, [
        {
          thread_id: "applied",
          pack_ids_json: '["web-craft"]',
          applied_pack_ids_json: '["web-craft"]',
          issue: null,
        },
        {
          thread_id: "degraded",
          pack_ids_json: '["effect"]',
          applied_pack_ids_json: '["effect"]',
          issue: "Missing skills: effect-docs",
        },
        {
          thread_id: "pending",
          pack_ids_json: '["web-craft","effect"]',
          applied_pack_ids_json: null,
          issue: null,
        },
      ]);
    }),
  );
});
