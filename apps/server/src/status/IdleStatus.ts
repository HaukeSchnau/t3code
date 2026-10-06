import { ThreadId, type ServerIdleBusyThread, type ServerIdleStatus } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PROCESS_BOUND_EFFECT_TYPES } from "../orchestration-v2/EffectOutbox.ts";

interface ThreadRow {
  readonly threadId: string;
}

interface RunRow extends ThreadRow {
  readonly status: "queued" | "preparing" | "starting" | "running" | "waiting";
  readonly provider: string;
}

interface SessionRow extends ThreadRow {
  readonly status: "starting" | "running" | "waiting";
  readonly provider: string;
}

interface RuntimeRequestRow extends ThreadRow {
  readonly kind: string;
  readonly responseType: string | null;
}

interface EffectRow extends ThreadRow {
  readonly effectType: string;
  readonly status: string;
}

/** Restart-relevant V2 work, as recorded by the server that owns the database. */
interface IdleWork {
  readonly runs: ReadonlyArray<RunRow>;
  readonly sessions: ReadonlyArray<SessionRow>;
  readonly runtimeRequests: ReadonlyArray<RuntimeRequestRow>;
  readonly effects: ReadonlyArray<EffectRow>;
}

// Startup recovery terminalizes active runs, stops provider sessions, closes requests that need
// the live provider, and cancels process-bound effects, so all of those block a restart. Queued
// runs and requests answered by a later message survive the restart and are only counted.
function summarizeServerIdleStatus(work: IdleWork, checkedAt: string): ServerIdleStatus {
  const busyThreads: Array<ServerIdleBusyThread> = [];
  const seen = new Set<string>();
  const busy = (thread: ServerIdleBusyThread) => {
    const key = `${thread.source}:${thread.reason}:${thread.threadId}`;
    if (seen.has(key)) return;
    seen.add(key);
    busyThreads.push(thread);
  };
  const counts = {
    liveActiveTurnCount: 0,
    projectedActiveTurnCount: 0,
    projectedStartingSessionCount: 0,
    projectedRunningTurnCount: 0,
    queuedMessageCount: 0,
    pendingApprovalCount: 0,
    pendingUserInputCount: 0,
  };

  for (const run of work.runs) {
    const threadId = ThreadId.make(run.threadId);
    switch (run.status) {
      case "queued":
        counts.queuedMessageCount += 1;
        break;
      case "preparing":
        busy({
          threadId,
          reason: "command-in-progress",
          source: "command-preprocessing",
          turnId: null,
          status: run.status,
          provider: run.provider,
          detail: "workspace preparation for the next run is still in progress",
        });
        break;
      case "starting":
        counts.projectedStartingSessionCount += 1;
        busy({
          threadId,
          reason: "projected-session-starting",
          source: "projection",
          turnId: null,
          status: run.status,
          provider: run.provider,
        });
        break;
      case "running":
      case "waiting":
        counts.projectedRunningTurnCount += 1;
        busy({
          threadId,
          reason: "projected-latest-turn-running",
          source: "projection",
          turnId: null,
          status: run.status,
          provider: run.provider,
        });
        break;
    }
  }

  for (const session of work.sessions) {
    const starting = session.status === "starting";
    if (starting) counts.projectedStartingSessionCount += 1;
    else counts.projectedActiveTurnCount += 1;
    busy({
      threadId: ThreadId.make(session.threadId),
      reason: starting ? "projected-session-starting" : "projected-active-turn",
      source: "projection",
      turnId: null,
      status: session.status,
      provider: session.provider,
    });
  }

  for (const request of work.runtimeRequests) {
    const userInput = request.kind === "user_input";
    if (userInput) counts.pendingUserInputCount += 1;
    else counts.pendingApprovalCount += 1;
    if (request.responseType === "message" || request.responseType === "not_resumable") continue;
    busy({
      threadId: ThreadId.make(request.threadId),
      reason: userInput ? "pending-user-input" : "pending-approval",
      source: "projection",
      turnId: null,
      detail: "the provider process must stay alive to receive the answer",
    });
  }

  for (const effect of work.effects) {
    busy({
      threadId: ThreadId.make(effect.threadId),
      reason: "command-in-progress",
      source: "command-preprocessing",
      turnId: null,
      status: effect.status,
      detail: `${effect.effectType} effect is ${effect.status}`,
    });
  }

  return {
    idle: busyThreads.length === 0,
    checkedAt,
    busyThreadCount: new Set(busyThreads.map((thread) => thread.threadId)).size,
    ...counts,
    busyThreads,
  };
}

const readIdleWork = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [runs, sessions, runtimeRequests, effects] = yield* Effect.all([
    sql<RunRow>`
      SELECT run.thread_id AS "threadId", run.status, run.provider
      FROM orchestration_v2_projection_runs AS run
      LEFT JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = run.thread_id
      WHERE thread.deleted_at IS NULL
        AND run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
    `,
    sql<SessionRow>`
      SELECT binding.thread_id AS "threadId", session.status, session.provider
      FROM orchestration_v2_projection_provider_sessions AS session
      JOIN orchestration_v2_projection_provider_session_bindings AS binding
        ON binding.provider_session_id = session.provider_session_id
      LEFT JOIN orchestration_v2_projection_threads AS thread
        ON thread.thread_id = binding.thread_id
      WHERE thread.deleted_at IS NULL
        AND session.status IN ('starting', 'running', 'waiting')
    `,
    sql<RuntimeRequestRow>`
      SELECT
        request.thread_id AS "threadId",
        request.kind,
        CASE WHEN json_valid(request.payload_json)
          THEN json_extract(request.payload_json, '$.responseCapability.type')
        END AS "responseType"
      FROM orchestration_v2_projection_runtime_requests AS request
      LEFT JOIN orchestration_v2_projection_threads AS thread
        ON thread.thread_id = request.thread_id
      WHERE thread.deleted_at IS NULL AND request.status = 'pending'
    `,
    sql<EffectRow>`
      SELECT effect.thread_id AS "threadId", effect.effect_type AS "effectType", effect.status
      FROM orchestration_v2_effect_outbox AS effect
      LEFT JOIN orchestration_v2_projection_threads AS thread
        ON thread.thread_id = effect.thread_id
      WHERE thread.deleted_at IS NULL
        AND effect.status IN ('pending', 'running')
        AND effect.effect_type IN ${sql.in(PROCESS_BOUND_EFFECT_TYPES)}
    `,
  ]);
  return { runs, sessions, runtimeRequests, effects } satisfies IdleWork;
});

export const getServerIdleStatus = Effect.fn("getServerIdleStatus")(function* () {
  const work = yield* readIdleWork;
  const now = yield* DateTime.now;
  return summarizeServerIdleStatus(work, DateTime.formatIso(now));
});
