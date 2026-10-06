import { CommandId, ThreadId, type OrchestrationV2Command, type RunId } from "@t3tools/contracts";
import {
  codexOverloadRetry,
  codexOverloadRetryMessageId,
  codexOverloadRetryRunIds,
} from "@t3tools/shared/codexTurnContinuation";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/** The automatic retry continues the failed run without a message, like a manual Resume. */
function retryCommand(threadId: ThreadId, runId: RunId): OrchestrationV2Command {
  const messageId = codexOverloadRetryMessageId(runId);
  return {
    type: "message.dispatch",
    // One retry per failed run, however often the sweep sees it.
    commandId: CommandId.make(messageId),
    threadId,
    messageId,
    manualContinuationOfRunId: runId,
    text: "",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

const makeSweep = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  return Effect.fn("CodexOverloadRetryWorker.sweep")(function* () {
    const now = yield* DateTime.now;
    // Threads whose latest started run failed with an overloaded model. The
    // retry sequence itself is derived from their recent runs below.
    const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT t.thread_id
      FROM orchestration_v2_projection_threads t
      INNER JOIN orchestration_v2_projection_runs r ON r.run_id = (
        SELECT latest.run_id FROM orchestration_v2_projection_runs latest
        WHERE latest.thread_id = t.thread_id
          AND latest.status <> 'queued'
          AND NOT (
            latest.status = 'cancelled'
            AND json_extract(latest.payload_json, '$.startedAt') IS NULL
          )
        ORDER BY latest.ordinal DESC, latest.run_id DESC LIMIT 1
      ) AND r.status = 'failed'
      WHERE t.deleted_at IS NULL
        AND json_extract(t.payload_json, '$.archivedAt') IS NULL
        AND json_extract(t.payload_json, '$.settledOverride') IS NOT 'settled'
        AND (
          json_extract(t.payload_json, '$.snoozedUntil') IS NULL
          OR julianday(json_extract(t.payload_json, '$.snoozedUntil')) <= julianday(${DateTime.formatIso(now)})
        )
        AND EXISTS (
          SELECT 1 FROM orchestration_v2_projection_turn_items error
          WHERE error.thread_id = t.thread_id AND error.run_id = r.run_id
            AND error.type = 'error' AND error.status = 'failed'
            AND json_extract(error.payload_json, '$.failure.code') = 'serverOverloaded'
        )
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runtime_requests request
          WHERE request.thread_id = t.thread_id AND request.status = 'pending'
        )
      ORDER BY t.thread_id
    `;
    for (const row of rows) {
      const threadId = ThreadId.make(row.thread_id);
      yield* Effect.gen(function* () {
        const history = yield* projections.getThreadRecords(threadId, ["runs", "providerThreads"]);
        const recent = yield* projections.getThreadRecords(threadId, ["turnItems"], {
          turnItemRunIds: codexOverloadRetryRunIds(history.runs),
        });
        const retry = codexOverloadRetry({ ...history, turnItems: recent.turnItems });
        if (retry?.phase !== "scheduled" || DateTime.isGreaterThan(retry.retryAt, now)) return;
        yield* threads.dispatch(retryCommand(threadId, retry.runId));
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.codex-overload-retry.failed", { threadId, cause }),
        ),
      );
    }
  });
});

// The shared scheduler derives due retries from persisted run history, so a
// restart resumes the sequence without restoring timers.
export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("codex-overload-retry", sweep());
  }),
);
