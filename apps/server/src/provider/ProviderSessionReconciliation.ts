import type {
  OrchestrationSession,
  ProviderSession,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * Narrow legacy read-model state needed to reconcile a provider session after
 * a process restart. The V2 projector owns an equivalent shape, but this
 * small pure policy remains useful to the legacy startup compatibility path.
 */
export interface ProjectionRestartSafetyThread {
  readonly threadId: ThreadId;
  readonly session: OrchestrationSession | null;
  readonly latestTurnId: TurnId | null;
  readonly latestTurnState: string | null;
  readonly latestTurnUpdatedAt: string | null;
  readonly queuedMessageCount: number;
  readonly pendingApprovalCount: number;
  readonly pendingUserInputCount: number;
  readonly undeliveredTranscriptEventCount: number;
}

export const SERVER_RUNTIME_STARTED_AT = DateTime.formatIso(DateTime.nowUnsafe());

export type ProviderSessionReconciliationReason =
  | "projection_current"
  | "live_turn_active"
  | "transcript_backlog"
  | "stale_projected_turn"
  | "terminal_live_session"
  | "unknown";

export type ProviderSessionReconciliationDecision =
  | {
      readonly _tag: "Skip";
      readonly reason: ProviderSessionReconciliationReason;
    }
  | {
      readonly _tag: "Repair";
      readonly reason: "stale_projected_turn" | "terminal_live_session";
      readonly repair:
        | {
            readonly _tag: "SetSession";
            readonly status: "ready" | "interrupted" | "stopped" | "error";
            readonly session: NonNullable<ProjectionRestartSafetyThread["session"]>;
          }
        | {
            readonly _tag: "InterruptTurn";
            readonly turnId: ProjectionRestartSafetyThread["latestTurnId"] & string;
          };
    };

export function hasProjectedActiveLifecycle(projected: ProjectionRestartSafetyThread): boolean {
  return (
    (projected.session?.activeTurnId !== null && projected.session?.activeTurnId !== undefined) ||
    projected.session?.status === "starting" ||
    projected.session?.status === "running" ||
    projected.latestTurnState === "running"
  );
}

/**
 * Reconcile only lifecycle state inherited from an older server process. A
 * same-epoch absence can be a provider-start or event-ingestion race and must
 * remain restart-blocking rather than being guessed terminal.
 */
export function decideProviderSessionReconciliation(input: {
  readonly projected: ProjectionRestartSafetyThread;
  readonly liveSession: ProviderSession | undefined;
  readonly runtimeStartedAt: string;
}): ProviderSessionReconciliationDecision {
  if (!hasProjectedActiveLifecycle(input.projected)) {
    return { _tag: "Skip", reason: "projection_current" };
  }

  if (input.liveSession?.activeTurnId !== undefined || input.liveSession?.status === "running") {
    return { _tag: "Skip", reason: "live_turn_active" };
  }

  const session = input.projected.session;
  if (input.projected.undeliveredTranscriptEventCount > 0) {
    return { _tag: "Skip", reason: "transcript_backlog" };
  }

  if (session !== null && session.updatedAt >= input.runtimeStartedAt) {
    return { _tag: "Skip", reason: "projection_current" };
  }

  if (
    session === null &&
    input.projected.latestTurnUpdatedAt !== null &&
    input.projected.latestTurnUpdatedAt >= input.runtimeStartedAt
  ) {
    return { _tag: "Skip", reason: "projection_current" };
  }

  if (session === null) {
    return input.projected.latestTurnState === "running" && input.projected.latestTurnId !== null
      ? {
          _tag: "Repair",
          reason: "stale_projected_turn",
          repair: { _tag: "InterruptTurn", turnId: input.projected.latestTurnId },
        }
      : { _tag: "Skip", reason: "unknown" };
  }

  if (input.liveSession !== undefined) {
    switch (input.liveSession.status) {
      case "error":
        return {
          _tag: "Repair",
          reason: "terminal_live_session",
          repair: { _tag: "SetSession", status: "error", session },
        };
      case "closed":
        return {
          _tag: "Repair",
          reason: "terminal_live_session",
          repair: { _tag: "SetSession", status: "stopped", session },
        };
      case "ready":
        return {
          _tag: "Repair",
          reason: "terminal_live_session",
          repair: { _tag: "SetSession", status: "ready", session },
        };
      case "connecting":
        return { _tag: "Skip", reason: "projection_current" };
    }
  }

  return {
    _tag: "Repair",
    reason: "stale_projected_turn",
    repair: { _tag: "SetSession", status: "interrupted", session },
  };
}
