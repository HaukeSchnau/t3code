import {
  type ProviderSession,
  type ServerIdleBusyThread,
  type ServerIdleStatus,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  ProjectionSnapshotQuery,
  type ProjectionRestartSafetyState,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  hasProjectedActiveLifecycle,
  SERVER_RUNTIME_STARTED_AT,
} from "../provider/ProviderSessionReconciliation.ts";

function busyThreadKey(thread: ServerIdleBusyThread): string {
  return `${thread.source}:${thread.reason}:${thread.threadId}:${thread.turnId ?? ""}`;
}

function pushBusyThread(
  busyThreads: Array<ServerIdleBusyThread>,
  seen: Set<string>,
  thread: ServerIdleBusyThread,
) {
  const key = busyThreadKey(thread);
  if (seen.has(key)) return;
  seen.add(key);
  busyThreads.push(thread);
}

export function summarizeServerIdleStatus(input: {
  readonly liveSessions: ReadonlyArray<ProviderSession>;
  readonly projectedState: ProjectionRestartSafetyState;
  readonly checkedAt: string;
  readonly runtimeStartedAt: string;
  readonly liveStateKnown: boolean;
}): ServerIdleStatus {
  const busyThreads: Array<ServerIdleBusyThread> = [];
  const seenBusyThreadKeys = new Set<string>();
  const counts = {
    liveActiveTurnCount: 0,
    projectedActiveTurnCount: 0,
    projectedStartingSessionCount: 0,
    projectedRunningTurnCount: 0,
    queuedMessageCount: 0,
    pendingApprovalCount: 0,
    pendingUserInputCount: 0,
  };

  for (const session of input.liveSessions) {
    const hasActiveTurn = session.activeTurnId !== undefined;
    if (hasActiveTurn || session.status === "running" || session.status === "connecting") {
      counts.liveActiveTurnCount += 1;
      pushBusyThread(busyThreads, seenBusyThreadKeys, {
        threadId: session.threadId,
        reason: hasActiveTurn ? "live-provider-active-turn" : "live-provider-session-busy",
        source: "live-provider",
        turnId: session.activeTurnId ?? null,
        status: session.status,
        provider: session.provider,
      });
    }
  }

  for (const projected of input.projectedState.threads) {
    const session = projected.session;
    if (session?.activeTurnId !== null && session?.activeTurnId !== undefined) {
      counts.projectedActiveTurnCount += 1;
    }
    if (session?.status === "starting") counts.projectedStartingSessionCount += 1;
    if (projected.latestTurnState === "running") counts.projectedRunningTurnCount += 1;
    counts.queuedMessageCount += projected.queuedMessageCount;
    counts.pendingApprovalCount += projected.pendingApprovalCount;
    counts.pendingUserInputCount += projected.pendingUserInputCount;

    const projectionBlocksRestart =
      hasProjectedActiveLifecycle(projected) &&
      (!input.liveStateKnown || session === null || session.updatedAt >= input.runtimeStartedAt);

    if (projectionBlocksRestart) {
      if (session?.activeTurnId !== null && session?.activeTurnId !== undefined) {
        pushBusyThread(busyThreads, seenBusyThreadKeys, {
          threadId: projected.threadId,
          reason: "projected-active-turn",
          source: "projection",
          turnId: session.activeTurnId,
          status: session.status,
          ...(session.providerName ? { provider: session.providerName } : {}),
        });
      }
      if (session?.status === "starting") {
        pushBusyThread(busyThreads, seenBusyThreadKeys, {
          threadId: projected.threadId,
          reason: "projected-session-starting",
          source: "projection",
          turnId: session.activeTurnId,
          status: session.status,
          ...(session.providerName ? { provider: session.providerName } : {}),
        });
      }
      if (projected.latestTurnState === "running") {
        pushBusyThread(busyThreads, seenBusyThreadKeys, {
          threadId: projected.threadId,
          reason: "projected-latest-turn-running",
          source: "projection",
          turnId: projected.latestTurnId,
          detail: "latest turn is still running in the current server epoch",
        });
      }
    }

    if (projected.undeliveredTranscriptEventCount > 0) {
      pushBusyThread(busyThreads, seenBusyThreadKeys, {
        threadId: projected.threadId,
        reason: "undelivered-transcript-events",
        source: "projection",
        turnId: session?.activeTurnId ?? projected.latestTurnId,
        detail: `${projected.undeliveredTranscriptEventCount} durable transcript event${projected.undeliveredTranscriptEventCount === 1 ? "" : "s"} awaiting ingestion`,
      });
    }
  }

  const busyThreadIds = new Set<ThreadId>(busyThreads.map((thread) => thread.threadId));
  return {
    idle: busyThreads.length === 0,
    checkedAt: input.checkedAt,
    busyThreadCount: busyThreadIds.size,
    ...counts,
    busyThreads,
  };
}

export const getServerIdleStatus = Effect.fn("getServerIdleStatus")(function* (options?: {
  readonly liveSessions?: ReadonlyArray<ProviderSession>;
  readonly runtimeStartedAt?: string;
}) {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const [projectedState, now] = yield* Effect.all([
    projectionSnapshotQuery.getRestartSafetyState !== undefined
      ? projectionSnapshotQuery.getRestartSafetyState()
      : projectionSnapshotQuery.getSnapshot().pipe(
          Effect.map((snapshot): ProjectionRestartSafetyState => ({
            threads: snapshot.threads
              .filter((thread) => thread.deletedAt === null)
              .map((thread) => ({
                threadId: thread.id,
                session: thread.session,
                latestTurnId: thread.latestTurn?.turnId ?? null,
                latestTurnState: thread.latestTurn?.state ?? null,
                latestTurnUpdatedAt:
                  thread.latestTurn?.completedAt ??
                  thread.latestTurn?.startedAt ??
                  thread.latestTurn?.requestedAt ??
                  null,
                queuedMessageCount: thread.queuedMessages?.length ?? 0,
                pendingApprovalCount: 0,
                pendingUserInputCount: 0,
                undeliveredTranscriptEventCount: 0,
              })),
          })),
        ),
    DateTime.now,
  ]);
  return summarizeServerIdleStatus({
    liveSessions: options?.liveSessions ?? [],
    projectedState,
    checkedAt: DateTime.formatIso(now),
    runtimeStartedAt: options?.runtimeStartedAt ?? SERVER_RUNTIME_STARTED_AT,
    liveStateKnown: options?.liveSessions !== undefined,
  });
});
