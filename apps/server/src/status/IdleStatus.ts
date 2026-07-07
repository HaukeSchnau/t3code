import {
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ProviderSession,
  type ServerIdleBusyThread,
  type ServerIdleStatus,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

type PendingRequestKind = "approval" | "user-input";

function extractRequestId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" && requestId.trim().length > 0 ? requestId : null;
}

function derivePendingRequestCount(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  kind: PendingRequestKind,
): number {
  const openRequestIds = new Set<string>();
  for (const activity of [...activities].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  )) {
    const requestId = extractRequestId(activity.payload);
    if (requestId === null) {
      continue;
    }

    if (kind === "approval") {
      if (activity.kind === "approval.requested") {
        openRequestIds.add(requestId);
      } else if (activity.kind === "approval.resolved") {
        openRequestIds.delete(requestId);
      }
      continue;
    }

    if (activity.kind === "user-input.requested") {
      openRequestIds.add(requestId);
      continue;
    }

    if (activity.kind === "user-input.resolved") {
      openRequestIds.delete(requestId);
      continue;
    }

    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
    if (
      activity.kind === "provider.user-input.respond.failed" &&
      detail !== null &&
      (detail.includes("stale pending user-input request") ||
        detail.includes("unknown pending user-input request") ||
        detail.includes("unknown pending user input request") ||
        detail.includes("unknown pending codex user input request"))
    ) {
      openRequestIds.delete(requestId);
    }
  }
  return openRequestIds.size;
}

function busyThreadKey(thread: ServerIdleBusyThread): string {
  return `${thread.source}:${thread.reason}:${thread.threadId}:${thread.turnId ?? ""}`;
}

function pushBusyThread(
  busyThreads: Array<ServerIdleBusyThread>,
  seen: Set<string>,
  thread: ServerIdleBusyThread,
) {
  const key = busyThreadKey(thread);
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  busyThreads.push(thread);
}

function summarizeProjectedThread(
  input: {
    readonly thread: OrchestrationThread;
    readonly busyThreads: Array<ServerIdleBusyThread>;
    readonly seenBusyThreadKeys: Set<string>;
  },
  counts: {
    projectedActiveTurnCount: number;
    projectedStartingSessionCount: number;
    projectedRunningTurnCount: number;
    queuedMessageCount: number;
    pendingApprovalCount: number;
    pendingUserInputCount: number;
  },
) {
  const { thread, busyThreads, seenBusyThreadKeys } = input;
  const session = thread.session;
  if (session?.activeTurnId !== null && session?.activeTurnId !== undefined) {
    counts.projectedActiveTurnCount += 1;
    pushBusyThread(busyThreads, seenBusyThreadKeys, {
      threadId: thread.id,
      reason: "projected-active-turn",
      source: "projection",
      turnId: session.activeTurnId,
      status: session.status,
      ...(session.providerName ? { provider: session.providerName } : {}),
    });
  }

  if (session?.status === "starting") {
    counts.projectedStartingSessionCount += 1;
    pushBusyThread(busyThreads, seenBusyThreadKeys, {
      threadId: thread.id,
      reason: "projected-session-starting",
      source: "projection",
      turnId: session.activeTurnId,
      status: session.status,
      ...(session.providerName ? { provider: session.providerName } : {}),
    });
  }

  if (thread.latestTurn?.state === "running") {
    counts.projectedRunningTurnCount += 1;
    pushBusyThread(busyThreads, seenBusyThreadKeys, {
      threadId: thread.id,
      reason: "projected-latest-turn-running",
      source: "projection",
      turnId: thread.latestTurn.turnId,
      detail: "latest turn is still running",
    });
  }

  const queuedMessages = thread.queuedMessages ?? [];
  if (queuedMessages.length > 0) {
    counts.queuedMessageCount += queuedMessages.length;
    pushBusyThread(busyThreads, seenBusyThreadKeys, {
      threadId: thread.id,
      reason: "queued-message",
      source: "projection",
      turnId: null,
      detail: `${queuedMessages.length} queued message${queuedMessages.length === 1 ? "" : "s"}`,
    });
  }

  const pendingApprovalCount = derivePendingRequestCount(thread.activities, "approval");
  if (pendingApprovalCount > 0) {
    counts.pendingApprovalCount += pendingApprovalCount;
    pushBusyThread(busyThreads, seenBusyThreadKeys, {
      threadId: thread.id,
      reason: "pending-approval",
      source: "projection",
      turnId: thread.latestTurn?.turnId ?? session?.activeTurnId ?? null,
      detail: `${pendingApprovalCount} pending approval${pendingApprovalCount === 1 ? "" : "s"}`,
    });
  }

  const pendingUserInputCount = derivePendingRequestCount(thread.activities, "user-input");
  if (pendingUserInputCount > 0) {
    counts.pendingUserInputCount += pendingUserInputCount;
    pushBusyThread(busyThreads, seenBusyThreadKeys, {
      threadId: thread.id,
      reason: "pending-user-input",
      source: "projection",
      turnId: thread.latestTurn?.turnId ?? session?.activeTurnId ?? null,
      detail: `${pendingUserInputCount} pending user-input request${
        pendingUserInputCount === 1 ? "" : "s"
      }`,
    });
  }
}

export function summarizeServerIdleStatus(input: {
  readonly liveSessions: ReadonlyArray<ProviderSession>;
  readonly snapshot: OrchestrationReadModel;
  readonly checkedAt: string;
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
    if (session.activeTurnId === undefined) {
      continue;
    }
    counts.liveActiveTurnCount += 1;
    pushBusyThread(busyThreads, seenBusyThreadKeys, {
      threadId: session.threadId,
      reason: "live-provider-active-turn",
      source: "live-provider",
      turnId: session.activeTurnId,
      status: session.status,
      provider: session.provider,
    });
  }

  for (const thread of input.snapshot.threads) {
    if (thread.deletedAt !== null) {
      continue;
    }
    summarizeProjectedThread({ thread, busyThreads, seenBusyThreadKeys }, counts);
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

export const getServerIdleStatus = Effect.fn("getServerIdleStatus")(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const [snapshot, now] = yield* Effect.all([projectionSnapshotQuery.getSnapshot(), DateTime.now]);
  return summarizeServerIdleStatus({
    liveSessions: [],
    snapshot,
    checkedAt: DateTime.formatIso(now),
  });
});
