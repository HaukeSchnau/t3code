import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(NodeSqliteClient.layerMemory());
const now = "2026-08-13T10:10:00.000Z";

layer("076_DropProviderUsageLimitsProjection", (it) => {
  it.effect("removes fork usage-limit events and their bookkeeping", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 75 });

      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        )
        VALUES (
          'evt-kept', 'thread', 'thread-kept', 0, 'thread.message-sent', ${now},
          NULL, NULL, NULL, 'server', '{}', '{}'
        )
      `;

      // What the fork persisted: a provider-aggregate usage event, and an older
      // usage snapshot appended to a thread as an activity.
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        )
        VALUES
          (
            'evt-usage', 'provider', 'codex', 0, 'provider.usage-limits-updated', ${now},
            'provider:usage', NULL, NULL, 'provider',
            '{"provider":"codex","providerInstanceId":"codex","usageLimits":{"limitId":"codex","limitName":null,"planType":null,"rateLimitReachedType":null,"credits":null,"primary":{"usedPercent":5,"resetsAt":"2026-08-20T08:15:43.000Z","windowDurationMins":10080},"secondary":null,"updatedAt":"2026-08-13T10:10:00.000Z"}}',
            '{}'
          ),
          (
            'evt-legacy-activity', 'thread', 'thread-kept', 1, 'thread.activity-appended', ${now},
            'provider:legacy', NULL, NULL, 'provider',
            '{"threadId":"thread-kept","activity":{"id":"evt-legacy-activity","tone":"info","kind":"account.rate-limits.updated","summary":"Rate limits updated","payload":{"usedPercent":5},"turnId":null,"createdAt":"2026-08-13T10:10:00.000Z"}}',
            '{}'
          )
      `;
      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error
        )
        VALUES ('provider:usage', 'provider', 'codex', ${now}, 2, 'accepted', NULL)
      `;
      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES ('projection.provider-usage-limits', 2, ${now})
      `;

      yield* runMigrations({ toMigrationInclusive: 76 });

      const events = yield* sql<{ readonly event_id: string }>`
        SELECT event_id FROM orchestration_events ORDER BY sequence
      `;
      assert.deepStrictEqual(
        events.map((event) => event.event_id),
        ["evt-kept"],
      );
      const leftovers = yield* sql<{ readonly count: number }>`
        SELECT
          (SELECT COUNT(*) FROM orchestration_command_receipts WHERE aggregate_kind = 'provider')
          + (SELECT COUNT(*) FROM projection_state WHERE projector = 'projection.provider-usage-limits')
          + (SELECT COUNT(*) FROM sqlite_master WHERE name = 'projection_provider_usage_limits')
          AS count
      `;
      assert.strictEqual(leftovers[0]?.count, 0);
    }),
  );
});
