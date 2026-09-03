import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("042_ProjectionThreadActivityRevision", (it) => {
  it.effect("indexes lossless per-turn activity reads in display order", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES
        (
          'activity-existing', 'thread-1', 'turn-1', 'tool', 'tool.completed', 'existing', '{}',
          NULL, '2026-07-17T00:00:00.000Z'
        ),
        (
          'activity-plan-boundary', 'thread-1', 'turn-1', 'tool', 'tool.completed', 'boundary',
          '{"detail":"ExitPlanMode: café 🚀"}', NULL, '2026-07-17T00:00:01.000Z'
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* runMigrations({ toMigrationInclusive: 42 });

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_thread_activities)
      `;
      assert.ok(
        indexes.some(
          (index) => index.name === "idx_projection_thread_activities_turn_canonical_order",
        ),
      );
      assert.ok(
        !indexes.some(
          (index) =>
            index.name === "idx_projection_thread_activities_thread_turn_sequence_created_id",
        ),
      );

      const indexDefinition = yield* sql<{ readonly sql: string }>`
        SELECT sql
        FROM sqlite_master
        WHERE type = 'index'
          AND name = 'idx_projection_thread_activities_turn_canonical_order'
      `;
      assert.match(
        indexDefinition[0]?.sql ?? "",
        /thread_id[\s\S]+turn_id[\s\S]+sequence IS NULL[\s\S]+sequence[\s\S]+created_at[\s\S]+activity_id/,
      );

      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT activity_id
        FROM projection_thread_activities
        WHERE thread_id = 'thread-1'
          AND turn_id = 'turn-1'
          AND kind NOT IN ('subagent.thread', 'turn.plan.updated')
        ORDER BY
          (sequence IS NULL) ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `;
      assert.ok(
        plan.some((row) =>
          row.detail.includes("idx_projection_thread_activities_turn_canonical_order"),
        ),
      );
      assert.ok(!plan.some((row) => row.detail.includes("USE TEMP B-TREE FOR ORDER BY")));

      const revisions = yield* sql<{
        readonly activityId: string;
        readonly activityRevision: number;
        readonly payloadBytes: number;
        readonly displayActivity: number;
      }>`
        SELECT
          activity_id AS "activityId",
          activity_revision AS "activityRevision",
          payload_bytes AS "payloadBytes",
          display_activity AS "displayActivity"
        FROM projection_thread_activities
        ORDER BY activity_id
      `;
      assert.equal(revisions[0]?.activityRevision, 0);
      assert.equal(revisions[0]?.payloadBytes, 2);
      assert.equal(revisions[0]?.displayActivity, 1);
      assert.equal(revisions[1]?.payloadBytes, 37);
      assert.equal(revisions[1]?.displayActivity, 0);
    }),
  );
});

const legacyDevelopmentLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

legacyDevelopmentLayer("042_ProjectionThreadActivityRevision legacy development upgrade", (it) => {
  it.effect("replaces the superseded migration 41 index while preserving legacy rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES (
          'activity-dev-legacy', 'thread-dev', 'turn-dev', 'tool', 'tool.completed', 'legacy',
          '{"detail":"preserved"}', 1, '2026-07-17T00:00:00.000Z'
        )
      `;
      yield* sql`
        CREATE INDEX idx_projection_thread_activities_thread_turn_sequence_created_id
        ON projection_thread_activities(
          thread_id,
          turn_id,
          (sequence IS NULL),
          sequence,
          created_at,
          activity_id
        )
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (41, 'ProjectionThreadActivityTurnLookupIndex')
      `;

      yield* runMigrations({ toMigrationInclusive: 42 });

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_thread_activities)
      `;
      assert.ok(
        indexes.some(
          (index) => index.name === "idx_projection_thread_activities_turn_canonical_order",
        ),
      );
      assert.ok(
        !indexes.some(
          (index) =>
            index.name === "idx_projection_thread_activities_thread_turn_sequence_created_id",
        ),
      );

      const rows = yield* sql<{
        readonly activityId: string;
        readonly payloadBytes: number;
      }>`
        SELECT
          activity_id AS "activityId",
          payload_bytes AS "payloadBytes"
        FROM projection_thread_activities
      `;
      assert.deepStrictEqual(rows, [
        {
          activityId: "activity-dev-legacy",
          payloadBytes: 22,
        },
      ]);
    }),
  );
});
