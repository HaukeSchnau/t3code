import { EventId, MessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStoreLive } from "../Layers/OrchestrationEventStore.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const now = "2026-08-13T10:10:00.000Z";

layer("076_DropProviderUsageLimitsProjection", (it) => {
  it.effect("removes fork usage-limit events so the event store decodes again", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 75 });

      const eventStore = yield* OrchestrationEventStore;
      const threadId = ThreadId.make("thread-kept");
      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.make("evt-kept"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("message-kept"),
          role: "assistant",
          text: "kept",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

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

      const before = yield* Stream.runCollect(eventStore.readAll()).pipe(Effect.exit);
      assert.strictEqual(before._tag, "Failure");

      yield* runMigrations({ toMigrationInclusive: 76 });

      const events = yield* Stream.runCollect(eventStore.readAll());
      assert.deepStrictEqual(
        Array.from(events, (event) => event.eventId),
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
    }).pipe(Effect.provide(OrchestrationEventStoreLive)),
  );
});
