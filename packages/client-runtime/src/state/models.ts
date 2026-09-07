import type {
  ThreadLinkedPullRequest,
  EnvironmentId,
  MessageId,
  OrchestrationProjectShell,
  OrchestrationLatestTurn,
  OrchestrationV2RunStatus,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  PlanId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface EnvironmentProject extends OrchestrationProjectShell {
  readonly environmentId: EnvironmentId;
}

/**
 * A pristine V2 thread projection paired with the environment that produced it.
 *
 * The projection stays nested so the server projection and all structurally
 * shared collections retain their identities. Rich consumers read V2 state
 * directly instead of a second presentation-shaped thread graph.
 */
export interface EnvironmentThread {
  readonly environmentId: EnvironmentId;
  readonly projection: OrchestrationV2ThreadProjection;
}

export interface ThreadRunSummary {
  readonly runId: RunId;
  readonly status: OrchestrationV2RunStatus;
  readonly requestedAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly assistantMessageId: MessageId | null;
  readonly sourcePlanRef?: {
    readonly threadId: ThreadId;
    readonly planId: PlanId;
  };
}

export interface ThreadRuntimeSummary {
  readonly status: OrchestrationV2RunStatus | "idle";
  readonly activeRunId: RunId | null;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerName: string | null;
  readonly lastError: string | null;
  readonly updatedAt: string;
}

export function threadRuntimeIsActive(runtime: ThreadRuntimeSummary | null | undefined): boolean {
  return runtime !== null && runtime !== undefined && threadRunStatusIsActive(runtime.status);
}

export function threadRunStatusIsActive(status: ThreadRuntimeSummary["status"]): boolean {
  return (
    status === "preparing" ||
    status === "queued" ||
    status === "starting" ||
    status === "running" ||
    status === "waiting"
  );
}

export interface EnvironmentThreadShell {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceId?: OrchestrationV2ThreadShell["workspaceId"];
  readonly titleMode?: OrchestrationV2ThreadShell["titleMode"];
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelSelection: OrchestrationV2ThreadShell["modelSelection"];
  readonly runtimeMode: OrchestrationV2ThreadShell["runtimeMode"];
  readonly interactionMode: OrchestrationV2ThreadShell["interactionMode"];
  readonly skillScope?: OrchestrationV2ThreadShell["skillScope"];
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly lineage: OrchestrationV2ThreadShell["lineage"];
  readonly forkedFrom: OrchestrationV2ThreadShell["forkedFrom"];
  readonly activeProviderThreadId: OrchestrationV2ThreadShell["activeProviderThreadId"];
  readonly latestRun: ThreadRunSummary | null;
  /** Compatibility projection for list rules while V2 shells expose latestRun. */
  readonly latestTurn?: {
    readonly state: OrchestrationLatestTurn["state"];
    readonly requestedAt: string | null;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  } | null;
  /** Compatibility projection for clients that still read session status. */
  readonly session?: { readonly status: string; readonly updatedAt?: string } | null;
  readonly runtime: ThreadRuntimeSummary | null;
  readonly latestUserMessageAt: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly hasActionableProposedPlan: boolean;
  readonly pendingBackgroundTasks: ReadonlyArray<
    NonNullable<OrchestrationV2ThreadShell["pendingBackgroundTasks"]>[number]
  >;
  readonly itemCount: number;
  readonly visibleItemCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly settledOverride: "settled" | "active" | null;
  readonly settledAt: string | null;
  readonly unsettledAt?: string | null;
  readonly snoozedUntil: string | null;
  readonly snoozedAt: string | null;
  readonly pinnedAt: string | null;
  /** Slot in the user-arranged pinned order; null for keyless (legacy) pins. */
  readonly pinOrderKey: string | null;
  /**
   * Pull request the user linked to the thread (#8160). Optional so clients
   * can still consume shells from pre-linking servers; UI treats undefined and
   * null alike.
   */
  readonly linkedPullRequest?: ThreadLinkedPullRequest | null;
  /** Legacy API name retained for client-side PR actions during V2 migration. */
  readonly branchPullRequest?: ThreadLinkedPullRequest | null;
  /** Active manual ordering slot, null when the thread has no arranged slot. */
  readonly activeOrderKey?: string | null;
  /**
   * Server-tracked visited watermark. `undefined` means the environment's
   * server predates visited tracking and clients should fall back to any
   * local visited state they keep.
   */
  readonly lastVisitedAt?: string | null;
  /** Pending title regeneration marker; null when no request is in flight. */
  readonly titleRegeneration?: { readonly requestId: string; readonly startedAt: string } | null;
  readonly deletedAt: string | null;
  readonly source: OrchestrationV2ThreadShell;
}

function iso(value: DateTime.Utc): string {
  return DateTime.formatIso(value);
}

function nullableIso(value: DateTime.Utc | null): string | null {
  return value === null ? null : iso(value);
}

function terminalRunStatus(status: OrchestrationV2RunStatus): boolean {
  return (
    status === "completed" ||
    status === "interrupted" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "rolled_back"
  );
}

// Park runtime at idle when the post-settlement background roster is nonempty
// so #4415 waiting-presentation Waiting (session.idle) can consume CTM runtime.
// The server suppresses the roster while an interruptible activity run exists,
// so a remaining roster is stronger than checkpoint-oriented waiting.
// latestRun keeps the latest run's status for history presentation.
function shellRuntime(thread: OrchestrationV2ThreadShell): ThreadRuntimeSummary | null {
  if (thread.latestRunId === null && thread.activeProviderThreadId === null) return null;
  const hasPendingBackgroundTasks = (thread.pendingBackgroundTasks?.length ?? 0) > 0;
  const status = hasPendingBackgroundTasks ? "idle" : (thread.activityRunStatus ?? thread.status);
  return {
    status,
    activeRunId: thread.activeRunId,
    providerInstanceId: thread.providerInstanceId,
    providerName: null,
    lastError: thread.lastError ?? null,
    updatedAt: iso(thread.updatedAt),
  };
}

export function scopeProject(
  environmentId: EnvironmentId,
  project: OrchestrationProjectShell,
): EnvironmentProject {
  return { ...project, environmentId };
}

export function presentThreadShell(
  environmentId: EnvironmentId,
  thread: OrchestrationV2ThreadShell,
): EnvironmentThreadShell {
  const updatedAt = iso(thread.updatedAt);
  const latestRun =
    thread.latestRunId === null
      ? null
      : ({
          runId: thread.latestRunId,
          status: thread.status === "idle" ? "completed" : thread.status,
          requestedAt: nullableIso(thread.latestRunRequestedAt ?? null),
          startedAt: nullableIso(thread.latestRunStartedAt ?? null),
          completedAt:
            thread.latestRunCompletedAt === undefined
              ? thread.status === "idle" || terminalRunStatus(thread.status)
                ? updatedAt
                : null
              : nullableIso(thread.latestRunCompletedAt),
          assistantMessageId: null,
        } satisfies ThreadRunSummary);
  const latestTurn =
    latestRun === null
      ? null
      : {
          state:
            latestRun.status === "completed"
              ? ("completed" as const)
              : latestRun.status === "interrupted"
                ? ("interrupted" as const)
                : latestRun.status === "failed" ||
                    latestRun.status === "cancelled" ||
                    latestRun.status === "rolled_back"
                  ? ("error" as const)
                  : ("running" as const),
          requestedAt: latestRun.requestedAt,
          startedAt: latestRun.startedAt,
          completedAt: latestRun.completedAt,
        };
  const activityRunStatus = thread.activityRunStatus ?? null;
  const session =
    thread.activeRunId === null && activityRunStatus === null
      ? null
      : {
          status:
            activityRunStatus === null
              ? thread.status === "failed"
                ? "error"
                : thread.status === "idle"
                  ? "idle"
                  : "running"
              : activityRunStatus,
          updatedAt,
        };
  return {
    environmentId,
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    ...(thread.workspaceId === undefined ? {} : { workspaceId: thread.workspaceId }),
    ...(thread.titleMode === undefined ? {} : { titleMode: thread.titleMode }),
    providerInstanceId: thread.providerInstanceId,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    ...(thread.skillScope === undefined ? {} : { skillScope: thread.skillScope }),
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    linkedPullRequest: thread.linkedPullRequest ?? null,
    lineage: thread.lineage,
    forkedFrom: thread.forkedFrom,
    activeProviderThreadId: thread.activeProviderThreadId,
    latestRun,
    latestTurn,
    session,
    runtime: shellRuntime(thread),
    latestUserMessageAt: nullableIso(thread.latestUserMessageAt),
    hasPendingApprovals:
      thread.pendingRuntimeRequest !== null &&
      thread.pendingRuntimeRequest.kind !== "user_input" &&
      thread.pendingRuntimeRequest.kind !== "auth_refresh",
    hasPendingUserInput: thread.pendingRuntimeRequest?.kind === "user_input",
    hasActionableProposedPlan: thread.hasActionableProposedPlan,
    pendingBackgroundTasks: thread.pendingBackgroundTasks ?? [],
    itemCount: thread.itemCount,
    visibleItemCount: thread.visibleItemCount,
    createdAt: iso(thread.createdAt),
    updatedAt,
    archivedAt: nullableIso(thread.archivedAt),
    settledOverride: thread.settledOverride,
    settledAt: nullableIso(thread.settledAt),
    unsettledAt: nullableIso(thread.unsettledAt ?? null),
    snoozedUntil: nullableIso(thread.snoozedUntil ?? null),
    snoozedAt: nullableIso(thread.snoozedAt ?? null),
    pinnedAt: nullableIso(thread.pinnedAt ?? null),
    pinOrderKey: thread.pinOrderKey ?? null,
    activeOrderKey: thread.activeOrderKey ?? null,
    ...(thread.lastVisitedAt === undefined
      ? {}
      : { lastVisitedAt: nullableIso(thread.lastVisitedAt) }),
    titleRegeneration:
      thread.titleRegeneration == null
        ? null
        : {
            requestId: thread.titleRegeneration.requestId,
            startedAt: iso(thread.titleRegeneration.startedAt),
          },
    deletedAt: nullableIso(thread.deletedAt),
    source: thread,
  };
}

export const scopeThreadShell = presentThreadShell;
