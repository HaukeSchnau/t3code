import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { OrchestrationUsageLimitHistoryWindow } from "@t3tools/contracts";

import { appendUsageLimitObservation } from "../ProviderUsageHistory.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_provider_usage_limits)
  `;

  if (!columns.some((column) => column.name === "history_json")) {
    yield* sql`
      ALTER TABLE projection_provider_usage_limits
      ADD COLUMN history_json TEXT NOT NULL DEFAULT '[]'
    `;
  }

  const observations = yield* sql<{
    readonly providerInstanceId: string;
    readonly observedAt: string;
    readonly resetsAt: string;
    readonly usedPercent: number;
    readonly windowDurationMins: number;
  }>`
    WITH observations AS (
      SELECT
        json_extract(payload_json, '$.providerInstanceId') AS provider_instance_id,
        occurred_at AS observed_at,
        json_extract(payload_json, '$.usageLimits.primary.resetsAt') AS resets_at,
        json_extract(payload_json, '$.usageLimits.primary.usedPercent') AS used_percent,
        json_extract(payload_json, '$.usageLimits.primary.windowDurationMins') AS duration_mins
      FROM orchestration_events
      WHERE event_type = 'provider.usage-limits-updated'
      UNION ALL
      SELECT
        json_extract(payload_json, '$.providerInstanceId'),
        occurred_at,
        json_extract(payload_json, '$.usageLimits.secondary.resetsAt'),
        json_extract(payload_json, '$.usageLimits.secondary.usedPercent'),
        json_extract(payload_json, '$.usageLimits.secondary.windowDurationMins')
      FROM orchestration_events
      WHERE event_type = 'provider.usage-limits-updated'
    )
    SELECT
      provider_instance_id AS "providerInstanceId",
      MIN(observed_at) AS "observedAt",
      resets_at AS "resetsAt",
      used_percent AS "usedPercent",
      duration_mins AS "windowDurationMins"
    FROM observations
    WHERE provider_instance_id IS NOT NULL
      AND resets_at IS NOT NULL
      AND used_percent > 0
      AND duration_mins > 0
    GROUP BY provider_instance_id, resets_at, duration_mins, used_percent
    ORDER BY "observedAt" ASC
  `;

  const historyByProvider = new Map<string, ReadonlyArray<OrchestrationUsageLimitHistoryWindow>>();
  for (const observation of observations) {
    historyByProvider.set(
      observation.providerInstanceId,
      appendUsageLimitObservation(
        historyByProvider.get(observation.providerInstanceId) ?? [],
        observation,
      ),
    );
  }

  for (const [providerInstanceId, history] of historyByProvider) {
    yield* sql`
      UPDATE projection_provider_usage_limits
      SET history_json = ${JSON.stringify(history)}
      WHERE provider_instance_id = ${providerInstanceId}
    `;
  }
});
