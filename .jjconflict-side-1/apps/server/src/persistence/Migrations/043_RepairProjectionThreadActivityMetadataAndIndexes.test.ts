import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const repairedWipLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

repairedWipLayer("043_RepairProjectionThreadActivityMetadataAndIndexes WIP repair", (it) => {
  it.effect("repairs a database that recorded the earlier revision-only migration 42", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES
          ('activity-repair-visible', 'thread-repair', 'turn-repair', 'tool', 'tool.completed',
            'visible', '{"detail":"café 🚀"}', 1, '2026-07-17T00:00:00.000Z'),
          ('activity-repair-hidden', 'thread-repair', 'turn-repair', 'tool', 'tool.completed',
            'Exited plan mode', '{"detail":"ExitPlanMode: done"}', NULL,
            '2026-07-17T00:00:01.000Z')
      `;
      yield* sql`
        ALTER TABLE projection_thread_activities
        ADD COLUMN activity_revision INTEGER NOT NULL DEFAULT 0
      `;
      yield* sql`
        CREATE INDEX idx_projection_thread_activities_thread_turn_sequence_created_id
        ON projection_thread_activities(
          thread_id, turn_id, (sequence IS NULL), sequence, created_at, activity_id
        )
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES
          (41, 'ProjectionThreadActivityTurnLookupIndex'),
          (42, 'ProjectionThreadActivityRevision')
      `;

      yield* runMigrations({ toMigrationInclusive: 43 });

      const rows = yield* sql<{
        readonly activityId: string;
        readonly revision: number;
        readonly payloadBytes: number;
        readonly displayActivity: number;
      }>`
        SELECT
          activity_id AS "activityId",
          activity_revision AS revision,
          payload_bytes AS "payloadBytes",
          display_activity AS "displayActivity"
        FROM projection_thread_activities
        ORDER BY activity_id
      `;
      assert.deepStrictEqual(rows, [
        {
          activityId: "activity-repair-hidden",
          revision: 0,
          payloadBytes: 31,
          displayActivity: 0,
        },
        {
          activityId: "activity-repair-visible",
          revision: 0,
          payloadBytes: 23,
          displayActivity: 1,
        },
      ]);

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_thread_activities)
      `;
      assert.ok(
        indexes.some(
          (index) => index.name === "idx_projection_thread_activities_turn_canonical_order",
        ),
      );
      assert.ok(
        indexes.some(
          (index) => index.name === "idx_projection_thread_activities_thread_canonical_order",
        ),
      );
      assert.ok(
        !indexes.some(
          (index) =>
            index.name === "idx_projection_thread_activities_thread_turn_sequence_created_id",
        ),
      );
      const triggers = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'trigger'
      `;
      assert.ok(
        triggers.some(
          (trigger) => trigger.name === "trg_projection_thread_activities_membership_immutable",
        ),
      );
    }),
  );
});

const currentProductionLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

currentProductionLayer(
  "043_RepairProjectionThreadActivityMetadataAndIndexes current schema",
  (it) => {
    it.effect("preserves current metadata and indexes canonical thread-wide reads", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* runMigrations({ toMigrationInclusive: 42 });
        yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
          activity_revision, payload_bytes, display_activity, sequence, created_at
        ) VALUES (
          'activity-current', 'thread-current', 'turn-current', 'tool', 'tool.completed',
          'current', '{}', 7, 999, 0, NULL, '2026-07-17T00:00:00.000Z'
        )
      `;

        yield* runMigrations({ toMigrationInclusive: 43 });

        const rows = yield* sql<{
          readonly revision: number;
          readonly payloadBytes: number;
          readonly displayActivity: number;
        }>`
        SELECT
          activity_revision AS revision,
          payload_bytes AS "payloadBytes",
          display_activity AS "displayActivity"
        FROM projection_thread_activities
        WHERE activity_id = 'activity-current'
      `;
        assert.deepStrictEqual(rows, [{ revision: 7, payloadBytes: 999, displayActivity: 0 }]);

        const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT activity_id
        FROM projection_thread_activities
        WHERE thread_id = 'thread-current'
        ORDER BY
          (sequence IS NULL) ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `;
        assert.ok(
          plan.some((row) =>
            row.detail.includes("idx_projection_thread_activities_thread_canonical_order"),
          ),
        );
        assert.ok(!plan.some((row) => row.detail.includes("USE TEMP B-TREE FOR ORDER BY")));
        const triggers = yield* sql<{ readonly name: string }>`
          SELECT name
          FROM sqlite_master
          WHERE type = 'trigger'
        `;
        assert.ok(
          triggers.some(
            (trigger) => trigger.name === "trg_projection_thread_activities_membership_immutable",
          ),
        );
      }),
    );
  },
);
