import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("109_ScheduledTaskOnceRunAt", (it) => {
  it.effect("renames a stored one-time schedule's at to runAt and leaves others alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 108 });
      const schedules = {
        "fork-once": '{"type":"once","at":"2026-11-03T04:30:00Z"}',
        "upstream-once": '{"type":"once","runAt":"2026-11-03T04:30:00+01:00"}',
        interval: '{"type":"interval","everyMs":60000}',
      };
      for (const [taskId, scheduleJson] of Object.entries(schedules)) {
        yield* sql`INSERT INTO scheduled_tasks ${sql.insert({
          task_id: taskId,
          title: "task",
          prompt: "Run",
          enabled: 1,
          schedule_json: scheduleJson,
          project_id: "project",
          thread_id: null,
          workspace_strategy_json: '{"type":"root"}',
          model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
          runtime_mode: "full-access",
          interaction_mode: "default",
          created_by: "user",
          creation_source: "web",
          created_at: "2026-10-01T00:00:00.000Z",
          updated_at: "2026-10-01T00:00:00.000Z",
          next_run_at: null,
          last_run_at: null,
          last_run_status: "never",
          last_run_error: null,
          run_count: 0,
        })}`;
      }
      yield* runMigrations({ toMigrationInclusive: 109 });

      const rows = yield* sql<{
        task_id: string;
        schedule_json: string;
      }>`SELECT task_id, schedule_json FROM scheduled_tasks ORDER BY task_id`;
      assert.deepEqual(
        rows.map((row) => [row.task_id, JSON.parse(row.schedule_json)]),
        [
          ["fork-once", { type: "once", runAt: "2026-11-03T04:30:00Z" }],
          ["interval", { type: "interval", everyMs: 60000 }],
          ["upstream-once", { type: "once", runAt: "2026-11-03T04:30:00+01:00" }],
        ],
      );
    }),
  );
});
