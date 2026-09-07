import {
  type OrchestrationV2ThreadShell,
  type ServerIdleBusyThread,
  type ServerIdleStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";

/**
 * Return the conservative restart-safety view from the V2 shell projection.
 * Shell rows contain the active run and pending-request summaries, so this
 * probe does not hydrate messages, activities, checkpoints, or transcripts.
 */
export function summarizeServerIdleStatus(input: {
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly checkedAt: string;
}): ServerIdleStatus {
  const busyThreads: Array<ServerIdleBusyThread> = [];
  const counts = {
    liveActiveTurnCount: 0,
    projectedActiveTurnCount: 0,
    projectedStartingSessionCount: 0,
    projectedRunningTurnCount: 0,
    queuedMessageCount: 0,
    pendingApprovalCount: 0,
    pendingUserInputCount: 0,
  };

  for (const thread of input.threads) {
    const activityStatus = thread.activityRunStatus;
    const hasActiveRun = thread.activeRunId !== null;
    const isStarting = activityStatus === "preparing" || activityStatus === "starting";
    const isRunning = activityStatus === "running";
    const isWaiting = activityStatus === "waiting";

    if (hasActiveRun) {
      // Native V2 has no separate provider-session list in the operational
      // shell. After startup recovery, an active run is the authoritative
      // evidence that a live provider turn still owns work in this process.
      counts.liveActiveTurnCount += 1;
      counts.projectedActiveTurnCount += 1;
    }
    if (isStarting) {
      counts.projectedStartingSessionCount += 1;
    }
    if (isRunning) {
      counts.projectedRunningTurnCount += 1;
    }
    // V2 keeps queued work as the latest run status while an older run may be
    // active. It is durable and therefore visible without blocking restart.
    if (thread.status === "queued") {
      counts.queuedMessageCount += 1;
    }

    const pendingRequest = thread.pendingRuntimeRequest;
    if (pendingRequest?.kind === "user_input") {
      counts.pendingUserInputCount += 1;
    } else if (pendingRequest !== null && pendingRequest?.kind !== "auth_refresh") {
      counts.pendingApprovalCount += 1;
    }

    // Queued messages and pending requests are durable state. They remain in
    // the response for operators but do not make a restart unsafe. A V2 run
    // in activity (including post-terminal waiting) does.
    if (isStarting || isRunning || isWaiting || hasActiveRun) {
      const reason = isStarting
        ? "projected-session-starting"
        : hasActiveRun
          ? "projected-active-turn"
          : "projected-latest-turn-running";
      busyThreads.push({
        threadId: thread.id,
        reason,
        source: "projection",
        turnId: null,
        status: activityStatus ?? thread.status,
        provider: String(thread.providerInstanceId),
        ...(isWaiting
          ? { detail: "latest run is waiting for post-terminal runtime work" }
          : {}),
      });
    }
  }

  return {
    idle: busyThreads.length === 0,
    checkedAt: input.checkedAt,
    busyThreadCount: new Set(busyThreads.map((thread) => thread.threadId)).size,
    ...counts,
    busyThreads,
  };
}

export const getServerIdleStatus = Effect.fn("getServerIdleStatus")(function* () {
  const projectionStore = yield* ProjectionStoreV2;
  // Include archived shells as well: archiving is durable UI state and a
  // native run can remain active until its interrupt is observed.
  const snapshot = yield* projectionStore.getShellSnapshot();
  const checkedAt = yield* DateTime.now;
  return summarizeServerIdleStatus({
    threads: [...snapshot.threads, ...snapshot.archivedThreads],
    checkedAt: DateTime.formatIso(checkedAt),
  });
});
