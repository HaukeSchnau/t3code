import {
  OrchestrationThreadActivity,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeActivity = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationThreadActivity),
);

/**
 * Read compact coordination facts from both projection generations. The
 * query deliberately selects only activity payloads; native turn-item
 * transcripts stay out of shell snapshots and shell streams.
 */
export const readCoordinationActivities = (
  sql: SqlClient.SqlClient,
  threadId?: ThreadId,
) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      readonly payload: string;
      readonly source_rank: number;
    }>`
      SELECT payload, source_rank FROM (
        SELECT
          json_object('id', activity_id, 'tone', tone, 'kind', kind,
            'summary', summary, 'payload', json(payload_json), 'turnId', turn_id,
            'createdAt', created_at) AS payload,
          created_at AS activity_created_at,
          activity_id AS activity_sort_id,
          0 AS source_rank
        FROM projection_thread_activities
        WHERE (${threadId ?? null} IS NULL OR thread_id = ${threadId ?? null})
          AND kind GLOB 'thread-orchestration.*'
        UNION ALL
        SELECT
          json_extract(payload_json, '$.coordinationActivity') AS payload,
          updated_at AS activity_created_at,
          turn_item_id AS activity_sort_id,
          1 AS source_rank
        FROM orchestration_v2_projection_turn_items
        WHERE (${threadId ?? null} IS NULL OR thread_id = ${threadId ?? null})
          AND type = 'system_notice'
          AND json_type(payload_json, '$.coordinationActivity') = 'object'
      )
      ORDER BY activity_created_at ASC, activity_sort_id ASC
    `;
    const decoded = yield* Effect.forEach(rows, (row) =>
      decodeActivity(row.payload).pipe(
        Effect.map((activity) => ({ activity, sourceRank: row.source_rank })),
      ),
    );
    const byId = new Map<string, (typeof decoded)[number]>();
    for (const entry of decoded) {
      const current = byId.get(entry.activity.id);
      if (current === undefined || entry.sourceRank >= current.sourceRank) {
        byId.set(entry.activity.id, entry);
      }
    }
    return Array.from(byId.values(), (entry) => entry.activity);
  });
