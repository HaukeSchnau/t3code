import { assert, it } from "@effect/vitest";
import { OrchestrationUsageLimitHistoryWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const encodeTestJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeHistory = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(OrchestrationUsageLimitHistoryWindow)),
);

layer("053_ProjectionProviderUsageHistory", (it) => {
  it.effect("adds bounded history storage to provider usage projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 52 });

      const usageLimits = {
        limitId: "codex",
        limitName: "Codex",
        planType: "pro",
        rateLimitReachedType: null,
        credits: null,
        primary: {
          usedPercent: 8,
          resetsAt: "2026-08-20T08:15:43.000Z",
          windowDurationMins: 10080,
        },
        secondary: null,
        updatedAt: "2026-08-13T12:10:00.000Z",
      };
      yield* sql`
        INSERT INTO projection_provider_usage_limits (
          provider_instance_id, provider, usage_limits_json, updated_at
        ) VALUES ('codex', 'codex', ${encodeTestJson(usageLimits)}, ${usageLimits.updatedAt})
      `;

      for (const [index, usedPercent] of [5, 5, 8].entries()) {
        const occurredAt = DateTime.formatIso(
          DateTime.add(DateTime.makeUnsafe("2026-08-13T10:10:00.000Z"), {
            minutes: index,
          }),
        );
        const payload = {
          provider: "codex",
          providerInstanceId: "codex",
          usageLimits: {
            ...usageLimits,
            primary: { ...usageLimits.primary, usedPercent },
            updatedAt: occurredAt,
          },
        };
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            actor_kind, payload_json, metadata_json
          ) VALUES (
            ${`event-${index}`}, 'provider', 'codex', ${index + 1},
            'provider.usage-limits-updated', ${occurredAt}, 'system',
            ${encodeTestJson(payload)}, '{}'
          )
        `;
      }

      yield* runMigrations({ toMigrationInclusive: 53 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_provider_usage_limits)
      `;
      assert.ok(columns.some((column) => column.name === "history_json"));

      const rows = yield* sql<{ readonly history: string }>`
        SELECT history_json AS history
        FROM projection_provider_usage_limits
        WHERE provider_instance_id = 'codex'
      `;
      assert.deepStrictEqual(decodeHistory(rows[0]!.history), [
        {
          resetsAt: "2026-08-20T08:15:43.000Z",
          windowDurationMins: 10080,
          points: [
            { observedAt: "2026-08-13T10:10:00.000Z", usedPercent: 5 },
            { observedAt: "2026-08-13T10:12:00.000Z", usedPercent: 8 },
          ],
        },
      ]);
    }),
  );
});
