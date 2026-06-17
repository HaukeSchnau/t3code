import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("034_BackfillProjectionThreadLatestTurnId", (it) => {
  it.effect("restores missing latest turn pointers from concrete turn rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 33 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES (
          'thread-latest-turn-backfill',
          'project-latest-turn-backfill',
          'Thread latest turn backfill',
          '{"instanceId":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          '2026-03-01T00:00:00.000Z',
          '2026-03-01T00:10:00.000Z',
          NULL,
          NULL,
          0,
          0,
          0,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-latest-turn-backfill',
            'turn-old',
            NULL,
            NULL,
            'completed',
            '2026-03-01T00:01:00.000Z',
            '2026-03-01T00:01:00.000Z',
            '2026-03-01T00:02:00.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-latest-turn-backfill',
            'turn-new',
            NULL,
            NULL,
            'completed',
            '2026-03-01T00:05:00.000Z',
            '2026-03-01T00:05:00.000Z',
            '2026-03-01T00:10:00.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 34 });

      const rows = yield* sql<{ readonly latestTurnId: string | null }>`
        SELECT latest_turn_id AS "latestTurnId"
        FROM projection_threads
        WHERE thread_id = 'thread-latest-turn-backfill'
      `;
      assert.deepStrictEqual(rows, [{ latestTurnId: "turn-new" }]);
    }),
  );
});
