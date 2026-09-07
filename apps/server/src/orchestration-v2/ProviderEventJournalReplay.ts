import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProviderEventIngestorV2 } from "./ProviderEventIngestor.ts";
import { ProviderEventJournal } from "./ProviderEventJournal.ts";

export class ProviderEventJournalReplayError extends Schema.TaggedErrorClass<ProviderEventJournalReplayError>()(
  "ProviderEventJournalReplayError",
  { cause: Schema.Defect() },
) {}

/** Startup runs this before recovery terminalizes runs and before provider workers can start. */
export const replayAcceptedProviderEvents = Effect.gen(function* () {
  const journal = yield* ProviderEventJournal;
  const ingestor = yield* ProviderEventIngestorV2;
  const sql = yield* SqlClient.SqlClient;
  const throughSequence = yield* journal.latestSequence;
  let afterSequence = 0;
  let replayedEventCount = 0;
  while (afterSequence < throughSequence) {
    const entries = yield* journal.readPending({ afterSequence, throughSequence, limit: 64 });
    if (entries.length === 0) break;
    for (const entry of entries) {
      afterSequence = entry.sequence;
      if (!(yield* journal.isPending(entry.id))) continue;
      const event = entry.event;
      let threadId = entry.context.threadId;
      // Shared provider sessions can emit events for several app threads. Older
      // adapters omit the thread field on turn/request snapshots.
      if (event.type === "provider_turn.updated" && event.threadId === undefined) {
        const rows = yield* sql<{ thread_id: string | null }>`
          SELECT thread_id FROM orchestration_v2_projection_provider_threads
          WHERE provider_thread_id = ${event.providerTurn.providerThreadId}
        `;
        if (rows[0]?.thread_id) threadId = ThreadId.make(rows[0].thread_id);
      } else if (event.type === "runtime_request.updated" && event.threadId === undefined) {
        const rows = yield* sql<{ thread_id: string }>`
          SELECT thread_id FROM orchestration_v2_projection_nodes
          WHERE node_id = ${event.runtimeRequest.nodeId}
        `;
        if (rows[0]) threadId = ThreadId.make(rows[0].thread_id);
      }
      const threads = yield* sql<{ deleted_at: string | null }>`
        SELECT json_extract(payload_json, '$.deletedAt') AS deleted_at
        FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
      `;
      if (threads[0]?.deleted_at != null) {
        yield* journal.commitAccepted(entry.id);
        continue;
      }
      // Session release resolves requests directly through the event sink. Pending
      // adapter snapshots accepted before release must not reopen those requests
      // or their approval UI when their volatile delivery was interrupted.
      const pendingRequestId =
        event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending"
          ? event.runtimeRequest.id
          : event.type === "node.updated" &&
              ["idle", "pending", "running", "waiting"].includes(event.node.status)
            ? event.node.runtimeRequestId
            : event.type === "turn_item.updated" &&
                event.turnItem.type === "approval_request" &&
                ["idle", "pending", "running", "waiting"].includes(event.turnItem.status)
              ? event.turnItem.requestId
              : null;
      if (pendingRequestId != null) {
        const requests = yield* sql<{ status: string }>`
          SELECT status FROM orchestration_v2_projection_runtime_requests
          WHERE runtime_request_id = ${pendingRequestId}
        `;
        if (requests[0] !== undefined && requests[0].status !== "pending") {
          yield* journal.commitAccepted(entry.id);
          continue;
        }
      }
      if (event.type === "provider_thread.updated") {
        const rows = yield* sql<{ last_run_ordinal: number | null; updated_at: string }>`
          SELECT last_run_ordinal, json_extract(payload_json, '$.updatedAt') AS updated_at
          FROM orchestration_v2_projection_provider_threads
          WHERE provider_thread_id = ${event.providerThread.id}
        `;
        const current = rows[0];
        if (
          current &&
          ((current.last_run_ordinal ?? 0) > (event.providerThread.lastRunOrdinal ?? 0) ||
            current.updated_at > DateTime.formatIso(event.providerThread.updatedAt))
        ) {
          yield* journal.commitAccepted(entry.id);
          continue;
        }
      }
      yield* ingestor.ingestNormalized({
        ...entry.context,
        threadId,
        acceptedProviderEventId: entry.id,
        event,
      });
      replayedEventCount += 1;
    }
  }
  return { replayedEventCount };
}).pipe(Effect.mapError((cause) => new ProviderEventJournalReplayError({ cause })));
