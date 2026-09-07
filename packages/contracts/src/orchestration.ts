import { SkillPackId, ThreadSkillScope } from "./skillPacks.ts";
import { ProviderDriverKind } from "./providerInstance.ts";
import {
  ProviderErrorClass,
  ProviderUnavailable,
  isProviderOverloadedError,
} from "./providerError.ts";
import { ThreadWorkspaceRootRole, ThreadWorkspaceRetentionPolicy } from "./workspace.ts";
export { ModelSelection } from "./modelSelection.ts";
export { ProjectScript } from "./project.ts";
export { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  ApprovalRequestId,
  CheckpointRef,
  CommandId,
  EnvironmentId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  ThreadOrchestrationEffortId,
  ThreadOrchestrationWaitId,
  ThreadOrchestrationWatchId,
  ThreadWorkspaceId,
  TrimmedNonEmptyString,
  TrimmedString,
  TurnId,
} from "./baseSchemas.ts";
import { ChatAttachment, UploadChatAttachment } from "./chatAttachment.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderUserInputAnswers,
  RuntimeMode,
} from "./providerPolicy.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ProjectScript, ProjectIconOverride } from "./project.ts";
export { ProjectIconColor, ProjectIconOverride } from "./project.ts";
import { RepositoryIdentity, ThreadEnvMode } from "./environment.ts";
import { OrchestrationProjectShell } from "./orchestrationProject.ts";
import {
  ApplicationEventMetadata,
  ApplicationProjectCreatedEvent,
  ApplicationProjectDeletedEvent,
  ApplicationProjectMetaUpdatedEvent,
} from "./applicationEvent.ts";

export { OrchestrationProjectShell } from "./orchestrationProject.ts";

export {
  ApplicationProjectCreatedPayload as ProjectCreatedPayload,
  ApplicationProjectDeletedPayload as ProjectDeletedPayload,
  ApplicationProjectMetaUpdatedPayload as ProjectMetaUpdatedPayload,
  OrchestrationClientOrigin,
} from "./applicationEvent.ts";

export {
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  ThreadTurnDiff,
  TurnCountRange,
} from "./checkpointDiff.ts";

// Correlation id is command id by design in this model.
export const CorrelationId = CommandId;
export type CorrelationId = typeof CorrelationId.Type;

export const ProjectFaviconPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(1024),
  Schema.isPattern(/\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/i),
);
export type ProjectFaviconPath = typeof ProjectFaviconPath.Type;

export const OrchestrationProject = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  // Per-project override for where new threads start. Null/absent means
  // "no override": clients fall back to t3.json, then the global setting.
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  defaultSkillPackIds: Schema.optional(Schema.Array(SkillPackId)),
  // Opt-in because background sync performs network I/O and may move the checkout.
  // Optional on the wire so cached snapshots from older servers still decode.
  autoPull: Schema.optional(Schema.Boolean),
  // Optional on the wire so cached snapshots from older servers still decode.
  faviconPath: Schema.optional(Schema.NullOr(ProjectFaviconPath)),
  projectIcon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationProject = typeof OrchestrationProject.Type;

export const OrchestrationMessageRole = Schema.Literals(["user", "assistant", "system"]);
export type OrchestrationMessageRole = typeof OrchestrationMessageRole.Type;

export const OrchestrationNotificationOrigin = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("watch"),
    watchId: ThreadOrchestrationWatchId,
    generation: NonNegativeInt,
    sequence: PositiveInt,
    eventCount: PositiveInt,
    decision: Schema.Literals(["wake", "close"]),
    summary: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("wait"),
    waitId: ThreadOrchestrationWaitId,
    state: Schema.Literals(["attention", "satisfied", "deadline-exceeded"]),
    summary: Schema.optional(TrimmedNonEmptyString),
  }),
]);
export type OrchestrationNotificationOrigin = typeof OrchestrationNotificationOrigin.Type;

export const OrchestrationMessage = Schema.Struct({
  id: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  origin: Schema.optional(OrchestrationNotificationOrigin),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationMessage = typeof OrchestrationMessage.Type;

export const OrchestrationProposedPlanId = TrimmedNonEmptyString;
export type OrchestrationProposedPlanId = typeof OrchestrationProposedPlanId.Type;

export const OrchestrationProposedPlan = Schema.Struct({
  id: OrchestrationProposedPlanId,
  turnId: Schema.NullOr(TurnId),
  planMarkdown: TrimmedNonEmptyString,
  implementedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  implementationThreadId: Schema.NullOr(ThreadId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProposedPlan = typeof OrchestrationProposedPlan.Type;

const SourceProposedPlanReference = Schema.Struct({
  threadId: ThreadId,
  planId: OrchestrationProposedPlanId,
});

export const OrchestrationQueuedMessage = Schema.Struct({
  messageId: MessageId,
  threadId: ThreadId,
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  origin: Schema.optional(OrchestrationNotificationOrigin),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationQueuedMessage = typeof OrchestrationQueuedMessage.Type;

export const OrchestrationSessionStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);
export type OrchestrationSessionStatus = typeof OrchestrationSessionStatus.Type;

export const OrchestrationTurnRetry = Schema.Union([
  Schema.Struct({
    phase: Schema.Literal("scheduled"),
    sourceTurnId: TurnId,
    attempt: PositiveInt,
    retryAt: IsoDateTime,
  }),
  Schema.Struct({
    phase: Schema.Literal("running"),
    sourceTurnId: TurnId,
    attempt: PositiveInt,
  }),
  Schema.Struct({
    phase: Schema.Literal("exhausted"),
    sourceTurnId: TurnId,
    attempt: PositiveInt,
  }),
]);
export type OrchestrationTurnRetry = typeof OrchestrationTurnRetry.Type;

export const OrchestrationSession = Schema.Struct({
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  lastErrorClass: Schema.optional(Schema.NullOr(ProviderErrorClass)),
  providerUnavailable: Schema.optional(Schema.NullOr(ProviderUnavailable)),
  turnRetry: Schema.optional(Schema.NullOr(OrchestrationTurnRetry)),
  updatedAt: IsoDateTime,
});
export type OrchestrationSession = typeof OrchestrationSession.Type;

export const OrchestrationCheckpointFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type OrchestrationCheckpointFile = typeof OrchestrationCheckpointFile.Type;

export const OrchestrationCheckpointStatus = Schema.Literals(["ready", "missing", "error"]);
export type OrchestrationCheckpointStatus = typeof OrchestrationCheckpointStatus.Type;

export const OrchestrationCheckpointSummary = Schema.Struct({
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type OrchestrationCheckpointSummary = typeof OrchestrationCheckpointSummary.Type;

export const OrchestrationThreadActivityTone = Schema.Literals([
  "info",
  "tool",
  "approval",
  "error",
]);
export type OrchestrationThreadActivityTone = typeof OrchestrationThreadActivityTone.Type;

export const OrchestrationActivityImageMedia = Schema.Struct({
  type: Schema.Literal("image"),
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  storageId: TrimmedNonEmptyString,
  sizeBytes: Schema.optional(NonNegativeInt),
  originalPath: Schema.optional(TrimmedNonEmptyString),
});
export type OrchestrationActivityImageMedia = typeof OrchestrationActivityImageMedia.Type;

export const OrchestrationActivityMedia = Schema.Union([OrchestrationActivityImageMedia]);
export type OrchestrationActivityMedia = typeof OrchestrationActivityMedia.Type;

export const OrchestrationThreadActivity = Schema.Struct({
  id: EventId,
  tone: OrchestrationThreadActivityTone,
  kind: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  payload: Schema.Unknown,
  turnId: Schema.NullOr(TurnId),
  /** Outer orchestration event sequence used for cache-safe activity revisions. */
  revision: Schema.optional(NonNegativeInt),
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type OrchestrationThreadActivity = typeof OrchestrationThreadActivity.Type;

/** Constant-size summary used to render a closed historical turn before hydration. */
export const OrchestrationThreadHistoricalActivityGroup = Schema.Struct({
  turnId: TurnId,
  /** Monotonic per-turn activity revision. Changes on insert, same-membership update, or pruning. */
  revision: NonNegativeInt,
  activityCount: NonNegativeInt,
  payloadBytes: NonNegativeInt,
  /** Activities that produce a work-log row before lifecycle collapsing. */
  displayActivityCount: NonNegativeInt,
  /** Created-at anchors selected from the first/last canonical activity rows. */
  firstActivityAt: IsoDateTime,
  lastActivityAt: IsoDateTime,
});
export type OrchestrationThreadHistoricalActivityGroup =
  typeof OrchestrationThreadHistoricalActivityGroup.Type;

const OrchestrationLatestTurnState = Schema.Literals([
  "running",
  "interrupted",
  "completed",
  "error",
]);
export type OrchestrationLatestTurnState = typeof OrchestrationLatestTurnState.Type;

export const OrchestrationLatestTurn = Schema.Struct({
  turnId: TurnId,
  state: OrchestrationLatestTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
});
export type OrchestrationLatestTurn = typeof OrchestrationLatestTurn.Type;

type ThreadTurnContinuationState = {
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly session: OrchestrationSession | null;
};

export function canResumeThreadTurnState(thread: ThreadTurnContinuationState | null | undefined) {
  const latestTurn = thread?.latestTurn;
  const session = thread?.session;
  if (
    latestTurn === null ||
    latestTurn === undefined ||
    session?.providerName !== "codex" ||
    session.status === "starting" ||
    session.status === "running"
  ) {
    return false;
  }
  if (latestTurn.state === "interrupted") {
    return true;
  }
  return (
    latestTurn.state === "error" &&
    session.activeTurnId === null &&
    isProviderOverloadedError({
      errorClass: session.lastErrorClass,
      message: session.lastError,
    })
  );
}

export const ThreadTitleRegeneration = Schema.Struct({
  requestId: CommandId,
  startedAt: IsoDateTime,
});
export type ThreadTitleRegeneration = typeof ThreadTitleRegeneration.Type;

export const ThreadTitleMode = Schema.Literals(["automatic", "manual"]);
export type ThreadTitleMode = typeof ThreadTitleMode.Type;

export const ThreadLinkedPullRequest = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
});
export type ThreadLinkedPullRequest = typeof ThreadLinkedPullRequest.Type;

export const OrchestrationThread = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  /** Absent on legacy threads whose title provenance is unknown. */
  titleMode: Schema.optional(ThreadTitleMode),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  skillScope: Schema.optional(ThreadSkillScope),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  workspaceId: Schema.optional(Schema.NullOr(ThreadWorkspaceId)),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  branchPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  settledAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // When the thread last re-entered the active list (any thread.unsettled).
  // Anchors the active-list sort so an unsettled thread surfaces at the top
  // instead of sinking back to its creation-order slot. Cleared on settle.
  // Optional so payloads from pre-stamp servers still decode.
  unsettledAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  // Snooze is an overlay on the active lifecycle, not a fourth destination:
  // a snoozed thread stays "active" in the model and is only suppressed from
  // the inbox until snoozedUntil passes (or the thread raises its hand).
  // Optional so payloads from pre-snooze servers still decode.
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  // Active pinned threads render in the pinned block. Settled and snoozed
  // threads remain in their respective shelves even when pinned.
  // Optional so payloads from pre-pinning servers still decode.
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  // Fractional index for user-arranged pinned order. Keyed threads sort by
  // string comparison ahead of keyless ones (which keep creation order), so
  // servers never need each other's threads to agree on the merged list.
  // Optional so payloads from pre-reorder servers still decode.
  pinOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // Manual Active placement. Keyless threads retain their creation/re-entry
  // order above the arranged run. Settling clears this slot.
  activeOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // Pending-only state. Optional so older servers remain compatible.
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  deletedAt: Schema.NullOr(IsoDateTime),
  messages: Schema.Array(OrchestrationMessage),
  proposedPlans: Schema.Array(OrchestrationProposedPlan).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  queuedMessages: Schema.optional(Schema.Array(OrchestrationQueuedMessage)),
  activities: Schema.Array(OrchestrationThreadActivity),
  historicalActivityGroups: Schema.optionalKey(
    Schema.Array(OrchestrationThreadHistoricalActivityGroup),
  ),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  session: Schema.NullOr(OrchestrationSession),
});
export type OrchestrationThread = typeof OrchestrationThread.Type;

export const OrchestrationUsageLimitWindowSnapshot = Schema.Struct({
  // Optional so older snapshots remain decodable. New provider-neutral
  // snapshots use the key to keep same-duration limits and their histories
  // separate, such as Claude's overall and model-scoped weekly limits.
  key: Schema.optional(TrimmedNonEmptyString),
  label: Schema.optional(TrimmedNonEmptyString),
  usedPercent: Schema.Number,
  resetsAt: Schema.NullOr(IsoDateTime),
  windowDurationMins: Schema.NullOr(Schema.Number),
});
export type OrchestrationUsageLimitWindowSnapshot =
  typeof OrchestrationUsageLimitWindowSnapshot.Type;

export const OrchestrationUsageLimitsSnapshot = Schema.Struct({
  limitId: Schema.NullOr(Schema.String),
  limitName: Schema.NullOr(Schema.String),
  planType: Schema.NullOr(Schema.String),
  rateLimitReachedType: Schema.NullOr(Schema.String),
  credits: Schema.NullOr(
    Schema.Struct({
      balance: Schema.NullOr(Schema.String),
      hasCredits: Schema.Boolean,
      unlimited: Schema.Boolean,
    }),
  ),
  primary: Schema.NullOr(OrchestrationUsageLimitWindowSnapshot),
  secondary: Schema.NullOr(OrchestrationUsageLimitWindowSnapshot),
  // New clients prefer the complete keyed list. Primary and secondary stay on
  // the wire so old clients can render the two compact provider windows.
  windows: Schema.optional(Schema.Array(OrchestrationUsageLimitWindowSnapshot)),
  updatedAt: IsoDateTime,
});
export type OrchestrationUsageLimitsSnapshot = typeof OrchestrationUsageLimitsSnapshot.Type;

export const OrchestrationUsageLimitObservation = Schema.Struct({
  observedAt: IsoDateTime,
  usedPercent: Schema.Number,
});
export type OrchestrationUsageLimitObservation = typeof OrchestrationUsageLimitObservation.Type;

export const OrchestrationUsageLimitHistoryWindow = Schema.Struct({
  windowKey: Schema.optional(TrimmedNonEmptyString),
  resetsAt: IsoDateTime,
  windowDurationMins: Schema.Number,
  points: Schema.Array(OrchestrationUsageLimitObservation),
});
export type OrchestrationUsageLimitHistoryWindow = typeof OrchestrationUsageLimitHistoryWindow.Type;

export const OrchestrationProviderUsageLimits = Schema.Struct({
  provider: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  usageLimits: OrchestrationUsageLimitsSnapshot,
  history: Schema.optional(Schema.Array(OrchestrationUsageLimitHistoryWindow)),
});
export type OrchestrationProviderUsageLimits = typeof OrchestrationProviderUsageLimits.Type;

export const OrchestrationReadModel = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProject),
  threads: Schema.Array(OrchestrationThread),
  usageLimits: Schema.Array(OrchestrationProviderUsageLimits).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  updatedAt: IsoDateTime,
});
export type OrchestrationReadModel = typeof OrchestrationReadModel.Type;

export const OrchestrationThreadShell = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  titleMode: Schema.optional(ThreadTitleMode),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  skillScope: Schema.optional(ThreadSkillScope),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  workspaceId: Schema.optional(Schema.NullOr(ThreadWorkspaceId)),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  branchPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  settledAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // See OrchestrationThread.unsettledAt: last re-entry into the active list.
  unsettledAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  pinOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  activeOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  session: Schema.NullOr(OrchestrationSession),
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  hasActionableProposedPlan: Schema.Boolean,
  /**
   * Native background work alive after the turn settles: "working" while
   * subagents/workflows run, "monitoring" when watch loops are the only
   * live work. Optional so old servers/clients interop; absent = none.
   */
  backgroundLiveness: Schema.optional(Schema.NullOr(Schema.Literals(["working", "monitoring"]))),
  /**
   * Current plan step while a turn runs, for the Working indicators
   * (sidebar row, in-chat working line). Cleared when the turn settles —
   * never persists as stale UI. Optional so old servers/clients interop.
   */
  planProgress: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        step: TrimmedNonEmptyString,
        completedSteps: NonNegativeInt,
        totalSteps: NonNegativeInt,
      }),
    ),
  ),
});
export type OrchestrationThreadShell = typeof OrchestrationThreadShell.Type;

export const OrchestrationThreadRef = Schema.Struct({
  environmentId: Schema.optional(EnvironmentId),
  threadId: ThreadId,
});
export type OrchestrationThreadRef = typeof OrchestrationThreadRef.Type;

export const OrchestrationThreadRelationshipShell = Schema.Struct({
  kind: Schema.Literals(["createdBy", "forkedFrom", "replaces"]),
  actor: OrchestrationThreadRef,
  target: OrchestrationThreadRef,
  label: Schema.optional(TrimmedNonEmptyString),
  effortId: Schema.optional(ThreadOrchestrationEffortId),
  launchTurnId: Schema.optional(Schema.NullOr(TurnId)),
  createdAt: IsoDateTime,
});
export type OrchestrationThreadRelationshipShell = typeof OrchestrationThreadRelationshipShell.Type;

export const OrchestrationEffortMemberShell = Schema.Struct({
  thread: OrchestrationThreadRef,
  label: TrimmedNonEmptyString,
  joinedAt: IsoDateTime,
});
export type OrchestrationEffortMemberShell = typeof OrchestrationEffortMemberShell.Type;

export const OrchestrationEffortShell = Schema.Struct({
  effortId: ThreadOrchestrationEffortId,
  coordinator: OrchestrationThreadRef,
  title: TrimmedNonEmptyString,
  members: Schema.Array(OrchestrationEffortMemberShell),
  openedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationEffortShell = typeof OrchestrationEffortShell.Type;

export const OrchestrationWaitMemberShell = Schema.Struct({
  thread: OrchestrationThreadRef,
  outcome: Schema.optional(
    Schema.Literals([
      "unknown",
      "queued",
      "running",
      "completed",
      "failed",
      "interrupted",
      "blocked-approval",
      "blocked-input",
    ]),
  ),
});
export type OrchestrationWaitMemberShell = typeof OrchestrationWaitMemberShell.Type;

export const OrchestrationWaitShell = Schema.Struct({
  waitId: ThreadOrchestrationWaitId,
  coordinator: OrchestrationThreadRef,
  effortId: Schema.optional(ThreadOrchestrationEffortId),
  members: Schema.Array(OrchestrationWaitMemberShell),
  mode: Schema.Literals(["all", "any"]),
  state: Schema.Literals(["open", "satisfied", "cancelled", "deadline-exceeded"]),
  openedAt: IsoDateTime,
  deadlineAt: Schema.NullOr(IsoDateTime),
  resolvedAt: Schema.NullOr(IsoDateTime),
  notificationPolicy: Schema.optional(
    Schema.Union([
      Schema.Struct({ type: Schema.Literal("raw") }),
      Schema.Struct({
        type: Schema.Literal("summarize"),
        instruction: Schema.optional(TrimmedNonEmptyString),
      }),
    ]),
  ),
});
export type OrchestrationWaitShell = typeof OrchestrationWaitShell.Type;

export const OrchestrationWatchSource = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("process"),
    argv: Schema.NonEmptyArray(TrimmedNonEmptyString),
    cwd: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("shell"),
    command: TrimmedNonEmptyString,
    cwd: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("websocket"),
    url: TrimmedNonEmptyString,
  }),
]);
export type OrchestrationWatchSource = typeof OrchestrationWatchSource.Type;

export const OrchestrationWatchPolicy = Schema.Union([
  Schema.Struct({ type: Schema.Literal("always") }),
  Schema.Struct({ type: Schema.Literal("model"), instruction: TrimmedNonEmptyString }),
]);
export type OrchestrationWatchPolicy = typeof OrchestrationWatchPolicy.Type;

export const OrchestrationWatchShell = Schema.Struct({
  watchId: ThreadOrchestrationWatchId,
  coordinator: OrchestrationThreadRef,
  source: OrchestrationWatchSource,
  policy: OrchestrationWatchPolicy,
  state: Schema.Literals(["open", "completed", "cancelled", "failed"]),
  generation: NonNegativeInt,
  lastSequence: NonNegativeInt,
  eventCount: NonNegativeInt,
  openedAt: IsoDateTime,
  deadlineAt: Schema.NullOr(IsoDateTime),
  lastEventAt: Schema.NullOr(IsoDateTime),
  closedAt: Schema.NullOr(IsoDateTime),
  lastSummary: Schema.NullOr(Schema.String),
});
export type OrchestrationWatchShell = typeof OrchestrationWatchShell.Type;

export const OrchestrationCoordinationShell = Schema.Struct({
  relationships: Schema.Array(OrchestrationThreadRelationshipShell),
  efforts: Schema.Array(OrchestrationEffortShell),
  waits: Schema.Array(OrchestrationWaitShell),
  watches: Schema.Array(OrchestrationWatchShell).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type OrchestrationCoordinationShell = typeof OrchestrationCoordinationShell.Type;

export const OrchestrationShellSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProjectShell),
  threads: Schema.Array(OrchestrationThreadShell),
  usageLimits: Schema.Array(OrchestrationProviderUsageLimits).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  coordination: Schema.optional(OrchestrationCoordinationShell),
  updatedAt: IsoDateTime,
});
export type OrchestrationShellSnapshot = typeof OrchestrationShellSnapshot.Type;

export const OrchestrationShellStreamEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project-upserted"),
    sequence: NonNegativeInt,
    project: OrchestrationProjectShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("project-removed"),
    sequence: NonNegativeInt,
    projectId: ProjectId,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-upserted"),
    sequence: NonNegativeInt,
    thread: OrchestrationThreadShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-removed"),
    sequence: NonNegativeInt,
    threadId: ThreadId,
  }),
  Schema.Struct({
    kind: Schema.Literal("usage-limits-updated"),
    sequence: NonNegativeInt,
    usageLimits: OrchestrationProviderUsageLimits,
  }),
  Schema.Struct({
    kind: Schema.Literal("coordination-updated"),
    sequence: NonNegativeInt,
    coordination: OrchestrationCoordinationShell,
  }),
]);
export type OrchestrationShellStreamEvent = typeof OrchestrationShellStreamEvent.Type;

export const OrchestrationShellCursorItem = Schema.Struct({
  kind: Schema.Literal("cursor"),
  sequence: NonNegativeInt,
});
export type OrchestrationShellCursorItem = typeof OrchestrationShellCursorItem.Type;

export const OrchestrationShellStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationShellSnapshot,
  }),
  OrchestrationShellCursorItem,
  OrchestrationShellStreamEvent,
  Schema.Struct({
    kind: Schema.Literal("synchronized"),
  }),
]);
export type OrchestrationShellStreamItem = typeof OrchestrationShellStreamItem.Type;

export const OrchestrationSubscribeShellInput = Schema.Struct({
  /**
   * When provided, the server skips the initial full shell snapshot and instead
   * replays shell events after this sequence before streaming live events.
   * Clients that already hold a cached (or HTTP-loaded) shell snapshot pass its
   * sequence here so the subscription resumes without re-sending the entire
   * projects/threads list (overlapping events are deduped by sequence on the
   * client).
   */
  afterSequence: Schema.optionalKey(NonNegativeInt),
  /**
   * Capability flag for sequence-only cursor frames. Older clients omit this
   * field, so servers must not send them a stream item their schema cannot
   * decode.
   */
  includeCursorItems: Schema.optionalKey(Schema.Boolean),
  /**
   * Requests an explicit marker after the subscription has emitted its initial
   * snapshot or catch-up replay and before it begins emitting live events.
   */
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
});
export type OrchestrationSubscribeShellInput = typeof OrchestrationSubscribeShellInput.Type;

export const OrchestrationThreadActivityDetailMode = Schema.Literals(["full", "compact"]);
export type OrchestrationThreadActivityDetailMode =
  typeof OrchestrationThreadActivityDetailMode.Type;

export const OrchestrationSubscribeThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestrationSubscribeThreadInput = typeof OrchestrationSubscribeThreadInput.Type;

/**
 * Bounds a thread detail read to a window of recent turns. `turnLimit` counts
 * turns with a user pending message (subagent/fan-out turns between them ride
 * along), so the window always contains the last N user prompts. `beforeCursor`
 * requests the disjoint page of older turns strictly before a previously
 * returned cursor. Requests without a window get the full thread; pagination is
 * strictly opt-in so older clients keep today's behavior on both HTTP and the
 * WebSocket fallback snapshot.
 */
export const OrchestrationThreadDetailWindow = Schema.Struct({
  turnLimit: Schema.optionalKey(PositiveInt),
  beforeCursor: Schema.optionalKey(TrimmedNonEmptyString),
});
export type OrchestrationThreadDetailWindow = typeof OrchestrationThreadDetailWindow.Type;

/**
 * Page metadata for a windowed thread detail read. `beforeCursor` is opaque and
 * exclusive: passing it back returns the adjacent disjoint slice of older
 * turns. `null` means the thread is fully loaded below this page. The
 * `snapshotSequence` mirrors the top-level snapshot sequence so history pages
 * can be sequence-checked against live state before merging.
 */
export const OrchestrationThreadDetailPage = Schema.Struct({
  beforeCursor: Schema.NullOr(TrimmedNonEmptyString),
  hasMore: Schema.Boolean,
  snapshotSequence: NonNegativeInt,
  /**
   * Highest event sequence applied to THIS thread at page read time. The
   * global `snapshotSequence` advances with every thread's events, so a
   * client cannot wait for it via its per-thread subscription; this
   * thread-scoped watermark is reachable. A client merging an older page
   * must first have applied live events up to it — otherwise a streaming
   * turn outside the loaded window could have deltas replayed on top of
   * page content that already includes them, duplicating text.
   */
  threadSequence: Schema.optionalKey(NonNegativeInt),
});
export type OrchestrationThreadDetailPage = typeof OrchestrationThreadDetailPage.Type;

export const OrchestrationThreadDetailSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  activityDetailMode: OrchestrationThreadActivityDetailMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("full" as const)),
  ),
  thread: OrchestrationThread,
  // Present only on windowed responses. Absent on full snapshots (and from
  // pre-pagination servers), which clients treat as fully loaded.
  page: Schema.optional(OrchestrationThreadDetailPage),
});
export type OrchestrationThreadDetailSnapshot = typeof OrchestrationThreadDetailSnapshot.Type;

export const OrchestrationTurnActivitiesSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  threadId: ThreadId,
  turnId: TurnId,
  revision: NonNegativeInt,
  payloadBytes: NonNegativeInt,
  activities: Schema.Array(OrchestrationThreadActivity),
});
export type OrchestrationTurnActivitiesSnapshot = typeof OrchestrationTurnActivitiesSnapshot.Type;

export const ProjectCreateCommand = Schema.Struct({
  defaultSkillPackIds: Schema.optional(Schema.Array(SkillPackId)),
  type: Schema.Literal("project.create"),
  commandId: CommandId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  createWorkspaceRootIfMissing: Schema.optional(Schema.Boolean),
  separateEnvironment: Schema.optional(Schema.Boolean),
  // Retained for older clients that sent an automatic create-time seed. The
  // server ignores it; explicit project defaults use project.meta.update.
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  createdAt: IsoDateTime,
});

export const ProjectMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.meta.update"),
  commandId: CommandId,
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  // Absent = leave unchanged; null = clear the override.
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  defaultSkillPackIds: Schema.optional(Schema.Array(SkillPackId)),
  autoPull: Schema.optional(Schema.Boolean),
  faviconPath: Schema.optional(Schema.NullOr(ProjectFaviconPath)),
  projectIcon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
});

export const ProjectDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.delete"),
  commandId: CommandId,
  projectId: ProjectId,
  force: Schema.optional(Schema.Boolean),
});

export const ProjectOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
]);
export type ProjectOrchestrationCommand = typeof ProjectOrchestrationCommand.Type;

const ThreadCreateCommand = Schema.Struct({
  titleMode: Schema.optional(ThreadTitleMode),
  skillScope: Schema.optional(ThreadSkillScope),
  type: Schema.Literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  skillPackIds: Schema.optional(Schema.Array(SkillPackId)),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  workspaceId: Schema.optional(Schema.NullOr(ThreadWorkspaceId)),
  createdAt: IsoDateTime,
  historyImport: Schema.optional(Schema.Literal(true)),
});

const ThreadDeleteCommand = Schema.Struct({
  type: Schema.Literal("thread.delete"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadArchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.archive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadUnarchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.unarchive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadSettleCommand = Schema.Struct({
  type: Schema.Literal("thread.settle"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadAutoSettleCommand = Schema.Struct({
  type: Schema.Literal("thread.auto-settle"),
  commandId: CommandId,
  threadId: ThreadId,
  snapshotSequence: NonNegativeInt,
  settledAt: IsoDateTime,
});

const ThreadUnsettleCommand = Schema.Struct({
  type: Schema.Literal("thread.unsettle"),
  commandId: CommandId,
  threadId: ThreadId,
  // Commands only carry "user": activity un-settles are decided server-side
  // (the decider emits thread.unsettled(reason: "activity") events directly,
  // never through this command), so a client cannot forge the neutral reset.
  reason: Schema.Literal("user"),
});

const ThreadSnoozeCommand = Schema.Struct({
  type: Schema.Literal("thread.snooze"),
  commandId: CommandId,
  threadId: ThreadId,
  // The wake time. Event-based wake conditions (PR merged, review posted)
  // will arrive as an optional condition field alongside this; time-based
  // snooze is just the first kind of condition.
  snoozedUntil: IsoDateTime,
});

const ThreadUnsnoozeCommand = Schema.Struct({
  type: Schema.Literal("thread.unsnooze"),
  commandId: CommandId,
  threadId: ThreadId,
  // Commands only carry "user": activity wakes are decided server-side (the
  // decider emits thread.unsnoozed(reason: "activity") directly), and timer
  // wakes need no event at all — clients derive visibility from snoozedUntil,
  // so a passed wake time simply stops classifying as snoozed.
  reason: Schema.Literal("user"),
});

const ThreadPinCommand = Schema.Struct({
  type: Schema.Literal("thread.pin"),
  commandId: CommandId,
  threadId: ThreadId,
  // Initial slot in the user-arranged pinned order (see ThreadPinReorderCommand).
  // Optional: clients on pre-reorder servers omit it, and the pinned block
  // falls back to creation order for keyless threads.
  orderKey: Schema.optional(TrimmedNonEmptyString),
});

const ThreadUnpinCommand = Schema.Struct({
  type: Schema.Literal("thread.unpin"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadPinReorderCommand = Schema.Struct({
  type: Schema.Literal("thread.pin.reorder"),
  commandId: CommandId,
  threadId: ThreadId,
  // Fractional index key: pinned threads sort by plain string comparison of
  // these keys, so a drag writes one key to one thread — neighbors (possibly
  // on other servers) are never touched. Clients compute a key that sorts
  // between the dropped position's neighbors.
  orderKey: TrimmedNonEmptyString,
});

const ThreadActiveReorderCommand = Schema.Struct({
  type: Schema.Literal("thread.active.reorder"),
  commandId: CommandId,
  threadId: ThreadId,
  orderKey: TrimmedNonEmptyString,
});

const ThreadMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.meta.update"),
  commandId: CommandId,
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  /** Server-generated titles opt into future automatic refreshes. */
  titleMode: Schema.optional(ThreadTitleMode),
  /** Compare-and-swap guard for background title refreshes. */
  expectedTitle: Schema.optional(TrimmedNonEmptyString),
  regenerateTitle: Schema.optional(Schema.Literal(true)),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  expectedBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  workspaceId: Schema.optional(Schema.NullOr(ThreadWorkspaceId)),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
}).check(
  Schema.makeFilter(
    (input) =>
      !(input.title !== undefined && input.regenerateTitle === true) ||
      "title and regenerateTitle cannot be specified together",
  ),
);

const ThreadRuntimeModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
});

const ThreadInteractionModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.interaction-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
});

const ThreadSkillPacksSetCommand = Schema.Struct({
  type: Schema.Literal("thread.skill-packs.set"),
  commandId: CommandId,
  threadId: ThreadId,
  packIds: Schema.Array(SkillPackId),
  createdAt: IsoDateTime,
});

const ThreadTurnStartBootstrapCreateThread = Schema.Struct({
  titleMode: Schema.optional(ThreadTitleMode),
  skillScope: Schema.optional(ThreadSkillScope),
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  skillPackIds: Schema.optional(Schema.Array(SkillPackId)),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  workspaceId: Schema.optional(Schema.NullOr(ThreadWorkspaceId)),
  createdAt: IsoDateTime,
});

const ThreadTurnStartBootstrapPrepareWorktree = Schema.Struct({
  projectCwd: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  branch: Schema.optional(TrimmedNonEmptyString),
  startFromOrigin: Schema.optional(Schema.Boolean),
});

const ThreadTurnStartBootstrapPrepareWorkspace = Schema.Struct({
  kind: Schema.optional(
    Schema.Literals(["auto", "git-detached", "jj-workspace", "directory-copy"]),
  ),
  roots: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      sourcePath: TrimmedNonEmptyString,
      role: ThreadWorkspaceRootRole,
      baseRevision: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
      startFromOrigin: Schema.optional(Schema.Boolean),
    }),
  ),
  displayNameSeed: Schema.optional(TrimmedNonEmptyString),
  retentionPolicy: Schema.optional(ThreadWorkspaceRetentionPolicy),
});

const ThreadTurnStartBootstrap = Schema.Struct({
  createThread: Schema.optional(ThreadTurnStartBootstrapCreateThread),
  prepareWorkspace: Schema.optional(ThreadTurnStartBootstrapPrepareWorkspace),
  prepareWorktree: Schema.optional(ThreadTurnStartBootstrapPrepareWorktree),
  runSetupScript: Schema.optional(Schema.Boolean),
});

export type ThreadTurnStartBootstrap = typeof ThreadTurnStartBootstrap.Type;

export const ThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
    origin: Schema.optional(OrchestrationNotificationOrigin),
  }),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

const ClientThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(Schema.Union([UploadChatAttachment, ChatAttachment])),
    origin: Schema.optional(OrchestrationNotificationOrigin),
  }),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

export const ThreadMessageDelivery = Schema.Literals(["immediate", "queued"]);
export type ThreadMessageDelivery = typeof ThreadMessageDelivery.Type;

export const ThreadMessageQueueCommand = Schema.Struct({
  type: Schema.Literal("thread.message.queue"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
    origin: Schema.optional(OrchestrationNotificationOrigin),
  }),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  // Server-owned callers can request the same immediate dispatch used by the
  // queued-message "Send now" action. Client composer submissions omit this
  // field and retain their current queue-while-busy behavior.
  delivery: Schema.optional(ThreadMessageDelivery),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

const ClientThreadMessageQueueCommand = Schema.Struct({
  type: Schema.Literal("thread.message.queue"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(UploadChatAttachment),
    origin: Schema.optional(OrchestrationNotificationOrigin),
  }),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

/** TODO: Remove after persisted pre-V2 outbox commands have drained on supported clients. */
export const LegacyOutboxCommand = Schema.Union([
  ClientThreadTurnStartCommand,
  ClientThreadMessageQueueCommand,
]);
export type LegacyOutboxCommand = typeof LegacyOutboxCommand.Type;

const ThreadQueuedMessageDeleteCommand = Schema.Struct({
  type: Schema.Literal("thread.queued-message.delete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  createdAt: IsoDateTime,
});

const ThreadQueuedMessageDispatchCommand = Schema.Struct({
  type: Schema.Literal("thread.queued-message.dispatch"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  createdAt: IsoDateTime,
});

const ThreadTurnInterruptCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.interrupt"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

export const ThreadTurnResumeCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.resume"),
  commandId: CommandId,
  threadId: ThreadId,
  interruptedTurnId: TurnId,
  automaticRetryAttempt: Schema.optional(PositiveInt),
  createdAt: IsoDateTime,
});

const ThreadApprovalRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.approval.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.user-input.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

// Closes an async question without answering it. The agent is not messaged;
// the composer is simply released. Native callback questions cannot be dismissed
// this way because the provider is blocked waiting on a reply.
const ThreadUserInputDismissCommand = Schema.Struct({
  type: Schema.Literal("thread.user-input.dismiss"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  createdAt: IsoDateTime,
});

const ThreadCheckpointRevertCommand = Schema.Struct({
  type: Schema.Literal("thread.checkpoint.revert"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadHistoryPruneCommand = Schema.Struct({
  type: Schema.Literal("thread.history.prune"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  createdAt: IsoDateTime,
});

const ThreadSessionStopCommand = Schema.Struct({
  type: Schema.Literal("thread.session.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
  // Settle-cleanup stops are conditional: the decider drops the stop if the
  // thread was re-engaged (unsettled, session starting/running, or a queued
  // turn start) between the settle and this command. Guarding in the decider
  // closes the race a post-settle snapshot read cannot: commands are decided
  // serially against the authoritative read model.
  onlyIfSettled: Schema.optional(Schema.Boolean),
});

const DispatchableClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadSettleCommand,
  ThreadUnsettleCommand,
  ThreadSnoozeCommand,
  ThreadUnsnoozeCommand,
  ThreadPinCommand,
  ThreadUnpinCommand,
  ThreadPinReorderCommand,
  ThreadActiveReorderCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadSkillPacksSetCommand,
  ThreadTurnStartCommand,
  ThreadMessageQueueCommand,
  ThreadQueuedMessageDeleteCommand,
  ThreadQueuedMessageDispatchCommand,
  ThreadTurnInterruptCommand,
  ThreadTurnResumeCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadUserInputDismissCommand,
  ThreadCheckpointRevertCommand,
  ThreadHistoryPruneCommand,
  ThreadSessionStopCommand,
]);
export type DispatchableClientOrchestrationCommand =
  typeof DispatchableClientOrchestrationCommand.Type;

export const ClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadSettleCommand,
  ThreadUnsettleCommand,
  ThreadSnoozeCommand,
  ThreadUnsnoozeCommand,
  ThreadPinCommand,
  ThreadUnpinCommand,
  ThreadPinReorderCommand,
  ThreadActiveReorderCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadSkillPacksSetCommand,
  ClientThreadTurnStartCommand,
  ClientThreadMessageQueueCommand,
  ThreadQueuedMessageDeleteCommand,
  ThreadQueuedMessageDispatchCommand,
  ThreadTurnInterruptCommand,
  ThreadTurnResumeCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadUserInputDismissCommand,
  ThreadCheckpointRevertCommand,
  ThreadHistoryPruneCommand,
  ThreadSessionStopCommand,
]);
export type ClientOrchestrationCommand = typeof ClientOrchestrationCommand.Type;

const ThreadSessionSetCommand = Schema.Struct({
  type: Schema.Literal("thread.session.set"),
  commandId: CommandId,
  threadId: ThreadId,
  session: OrchestrationSession,
  createdAt: IsoDateTime,
});

const ThreadSkillScopeApplyCommand = Schema.Struct({
  type: Schema.Literal("thread.skill-scope.apply"),
  commandId: CommandId,
  threadId: ThreadId,
  version: PositiveInt,
  state: Schema.Literals(["ready", "degraded"]),
  issue: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantDeltaCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.delta"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  delta: Schema.String,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadMessagesImportCommand = Schema.Struct({
  type: Schema.Literal("thread.messages.import"),
  commandId: CommandId,
  threadId: ThreadId,
  messages: Schema.Array(OrchestrationMessage),
  createdAt: IsoDateTime,
});

const ThreadHistoryImportCommand = Schema.Struct({
  type: Schema.Literal("thread.history.import"),
  commandId: CommandId,
  threadId: ThreadId,
  messages: Schema.Array(
    Schema.Struct({
      messageId: MessageId,
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String,
      createdAt: IsoDateTime,
    }),
  ).check(Schema.isNonEmpty()),
});

const ThreadProposedPlanUpsertCommand = Schema.Struct({
  type: Schema.Literal("thread.proposed-plan.upsert"),
  commandId: CommandId,
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
  createdAt: IsoDateTime,
});

const ThreadTurnDiffCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.diff.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  completedAt: IsoDateTime,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.optional(MessageId),
  checkpointTurnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadActivityAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.activity.append"),
  commandId: CommandId,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
  createdAt: IsoDateTime,
});

const ThreadRevertCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.revert.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadHistoryPruneCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.history.prune.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  pruneFromCreatedAt: IsoDateTime,
  prunedTurnIds: Schema.Array(TurnId),
  createdAt: IsoDateTime,
});

const ProviderUsageLimitsUpdateCommand = Schema.Struct({
  type: Schema.Literal("provider.usage-limits.update"),
  commandId: CommandId,
  provider: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  usageLimits: OrchestrationUsageLimitsSnapshot,
  createdAt: IsoDateTime,
});

const ThreadTitleRegenerationCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.title.regeneration.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: CommandId,
  title: Schema.optional(TrimmedNonEmptyString),
});

const ThreadPullRequestSyncCommand = Schema.Struct({
  type: Schema.Literal("thread.pull-request.sync"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  snapshotSequence: NonNegativeInt,
  expected: Schema.Struct({
    workspaceRoot: TrimmedNonEmptyString,
    branch: Schema.NullOr(TrimmedNonEmptyString),
    worktreePath: Schema.NullOr(TrimmedNonEmptyString),
    linkedPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
    branchPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
  }),
  branchPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
  linkedPullRequest: Schema.optional(ThreadLinkedPullRequest),
});

const InternalOrchestrationCommand = Schema.Union([
  ThreadAutoSettleCommand,
  ThreadSessionSetCommand,
  ThreadSkillScopeApplyCommand,
  ThreadMessageAssistantDeltaCommand,
  ThreadMessageAssistantCompleteCommand,
  ThreadMessagesImportCommand,
  ThreadHistoryImportCommand,
  ThreadProposedPlanUpsertCommand,
  ThreadTurnDiffCompleteCommand,
  ThreadActivityAppendCommand,
  ThreadRevertCompleteCommand,
  ThreadHistoryPruneCompleteCommand,
  ProviderUsageLimitsUpdateCommand,
  ThreadTitleRegenerationCompleteCommand,
  ThreadPullRequestSyncCommand,
]);
export type InternalOrchestrationCommand = typeof InternalOrchestrationCommand.Type;

export const OrchestrationCommand = Schema.Union([
  DispatchableClientOrchestrationCommand,
  InternalOrchestrationCommand,
]);
export type OrchestrationCommand = typeof OrchestrationCommand.Type;

export const OrchestrationEventType = Schema.Literals([
  "project.created",
  "project.meta-updated",
  "project.deleted",
  "thread.created",
  "thread.deleted",
  "thread.archived",
  "thread.unarchived",
  "thread.settled",
  "thread.unsettled",
  "thread.snoozed",
  "thread.unsnoozed",
  "thread.pinned",
  "thread.unpinned",
  "thread.pin-reordered",
  "thread.meta-updated",
  "thread.runtime-mode-set",
  "thread.interaction-mode-set",
  "thread.skill-packs-set",
  "thread.skill-scope-applied",
  "thread.message-queued",
  "thread.queued-message-deleted",
  "thread.queued-message-dispatched",
  "thread.message-sent",
  "thread.turn-start-requested",
  "thread.turn-interrupt-requested",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.checkpoint-revert-requested",
  "thread.reverted",
  "thread.history-prune-requested",
  "thread.history-pruned",
  "thread.session-stop-requested",
  "thread.session-set",
  "thread.proposed-plan-upserted",
  "thread.turn-diff-completed",
  "thread.activity-appended",
  "provider.usage-limits-updated",
]);
export type OrchestrationEventType = typeof OrchestrationEventType.Type;

export const OrchestrationAggregateKind = Schema.Literals(["project", "thread", "provider"]);
export type OrchestrationAggregateKind = typeof OrchestrationAggregateKind.Type;
export const OrchestrationActorKind = Schema.Literals(["client", "server", "provider"]);

export const ThreadCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  titleMode: Schema.optional(ThreadTitleMode),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  skillScope: Schema.optional(ThreadSkillScope),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  workspaceId: Schema.optional(Schema.NullOr(ThreadWorkspaceId)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadDeletedPayload = Schema.Struct({
  threadId: ThreadId,
  deletedAt: IsoDateTime,
});

export const ThreadArchivedPayload = Schema.Struct({
  threadId: ThreadId,
  archivedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnarchivedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});

export const ThreadSettledPayload = Schema.Struct({
  threadId: ThreadId,
  settledAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnsettledPayload = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.Literals(["user", "activity"]),
  updatedAt: IsoDateTime,
});

export const ThreadSnoozedPayload = Schema.Struct({
  threadId: ThreadId,
  snoozedUntil: IsoDateTime,
  snoozedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnsnoozedPayload = Schema.Struct({
  threadId: ThreadId,
  // user: explicit "wake now". activity: real work arrived (user message /
  // session coming alive) and the decider cleared the snooze — mirrors
  // thread.unsettled's activity resets. Timer wakes emit no event: clients
  // derive them from snoozedUntil passing.
  reason: Schema.Literals(["user", "activity"]),
  updatedAt: IsoDateTime,
});

export const ThreadPinnedPayload = Schema.Struct({
  threadId: ThreadId,
  pinnedAt: IsoDateTime,
  // Absent on re-pins of an already-pinned thread (the existing key wins)
  // and on pins from clients that predate reordering.
  pinOrderKey: Schema.optional(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});

export const ThreadUnpinnedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});

export const ThreadPinReorderedPayload = Schema.Struct({
  threadId: ThreadId,
  orderKey: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});

export const ThreadMetaUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  // Order updates use this existing event so older clients can ignore the
  // new field while continuing to decode the event stream.
  activeOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  title: Schema.optional(TrimmedNonEmptyString),
  titleMode: Schema.optional(ThreadTitleMode),
  /** Intent marker consumed by the title-generation reactor. Keeping this on
      the existing event lets older clients safely ignore the new field. */
  regenerateTitle: Schema.optional(Schema.Literal(true)),
  /** Title at request time, used to avoid overwriting a later manual rename. */
  previousTitle: Schema.optional(TrimmedNonEmptyString),
  /** Pending state shared with clients. Null clears a matching request. */
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  workspaceId: Schema.optional(Schema.NullOr(ThreadWorkspaceId)),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  branchPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  updatedAt: IsoDateTime,
});

export const ThreadRuntimeModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  updatedAt: IsoDateTime,
});

export const ThreadInteractionModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  updatedAt: IsoDateTime,
});

export const ThreadSkillPacksSetPayload = Schema.Struct({
  threadId: ThreadId,
  version: PositiveInt,
  packIds: Schema.Array(SkillPackId),
  updatedAt: IsoDateTime,
});

export const ThreadSkillScopeAppliedPayload = Schema.Struct({
  threadId: ThreadId,
  version: PositiveInt,
  state: Schema.Literals(["ready", "degraded"]),
  issue: Schema.optional(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});

export const ThreadMessageSentPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  origin: Schema.optional(OrchestrationNotificationOrigin),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadMessageQueuedPayload = Schema.Struct({
  threadId: ThreadId,
  queuedMessage: OrchestrationQueuedMessage,
});

export const ThreadQueuedMessageDeletedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  deletedAt: IsoDateTime,
});

export const ThreadQueuedMessageDispatchedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  dispatchedAt: IsoDateTime,
});

export const ThreadTurnStartRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: Schema.NullOr(MessageId),
  resumedFromTurnId: Schema.optional(TurnId),
  automaticRetryAttempt: Schema.optional(PositiveInt),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

export const ThreadTurnInterruptRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

export const ThreadApprovalResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

export const ThreadCheckpointRevertRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const ThreadRevertedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
});

export const ThreadHistoryPruneRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  createdAt: IsoDateTime,
});

export const ThreadHistoryPrunedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  pruneFromCreatedAt: IsoDateTime,
  prunedTurnIds: Schema.Array(TurnId),
});

export const ThreadSessionStopRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

export const ThreadSessionSetPayload = Schema.Struct({
  threadId: ThreadId,
  session: OrchestrationSession,
});

export const ThreadProposedPlanUpsertedPayload = Schema.Struct({
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
});

export const ThreadTurnDiffCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});

export const ThreadActivityAppendedPayload = Schema.Struct({
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
});

export const OrchestrationEventMetadata = ApplicationEventMetadata;
export type OrchestrationEventMetadata = typeof OrchestrationEventMetadata.Type;

const EventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId, ProviderInstanceId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  metadata: OrchestrationEventMetadata,
} as const;

export const ProviderUsageLimitsUpdatedPayload = Schema.Struct({
  provider: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  usageLimits: OrchestrationUsageLimitsSnapshot,
});

export const OrchestrationEvent = Schema.Union([
  ApplicationProjectCreatedEvent,
  ApplicationProjectMetaUpdatedEvent,
  ApplicationProjectDeletedEvent,
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.created"),
    payload: ThreadCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.deleted"),
    payload: ThreadDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.archived"),
    payload: ThreadArchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unarchived"),
    payload: ThreadUnarchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.settled"),
    payload: ThreadSettledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unsettled"),
    payload: ThreadUnsettledPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.snoozed"),
    payload: ThreadSnoozedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unsnoozed"),
    payload: ThreadUnsnoozedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pinned"),
    payload: ThreadPinnedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unpinned"),
    payload: ThreadUnpinnedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pin-reordered"),
    payload: ThreadPinReorderedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.meta-updated"),
    payload: ThreadMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-mode-set"),
    payload: ThreadRuntimeModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.interaction-mode-set"),
    payload: ThreadInteractionModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.skill-packs-set"),
    payload: ThreadSkillPacksSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.skill-scope-applied"),
    payload: ThreadSkillScopeAppliedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.message-queued"),
    payload: ThreadMessageQueuedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.queued-message-deleted"),
    payload: ThreadQueuedMessageDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.queued-message-dispatched"),
    payload: ThreadQueuedMessageDispatchedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.message-sent"),
    payload: ThreadMessageSentPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-start-requested"),
    payload: ThreadTurnStartRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-interrupt-requested"),
    payload: ThreadTurnInterruptRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.approval-response-requested"),
    payload: ThreadApprovalResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.user-input-response-requested"),
    payload: ThreadUserInputResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.checkpoint-revert-requested"),
    payload: ThreadCheckpointRevertRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.reverted"),
    payload: ThreadRevertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.history-prune-requested"),
    payload: ThreadHistoryPruneRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.history-pruned"),
    payload: ThreadHistoryPrunedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-stop-requested"),
    payload: ThreadSessionStopRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-set"),
    payload: ThreadSessionSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.proposed-plan-upserted"),
    payload: ThreadProposedPlanUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-diff-completed"),
    payload: ThreadTurnDiffCompletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.activity-appended"),
    payload: ThreadActivityAppendedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("provider.usage-limits-updated"),
    payload: ProviderUsageLimitsUpdatedPayload,
  }),
]);
export type OrchestrationEvent = typeof OrchestrationEvent.Type;

export const OrchestrationThreadStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationThreadDetailSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("event"),
    event: OrchestrationEvent,
  }),
  Schema.Struct({
    kind: Schema.Literal("synchronized"),
  }),
]);
export type OrchestrationThreadStreamItem = typeof OrchestrationThreadStreamItem.Type;

export const OrchestrationCommandReceiptStatus = Schema.Literals(["accepted", "rejected"]);
export type OrchestrationCommandReceiptStatus = typeof OrchestrationCommandReceiptStatus.Type;

export const ProviderSessionRuntimeStatus = Schema.Literals([
  "starting",
  "running",
  "stopped",
  "error",
]);
export type ProviderSessionRuntimeStatus = typeof ProviderSessionRuntimeStatus.Type;

const ProjectionThreadTurnStatus = Schema.Literals([
  "running",
  "completed",
  "interrupted",
  "error",
]);
export type ProjectionThreadTurnStatus = typeof ProjectionThreadTurnStatus.Type;

const ProjectionCheckpointRow = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type ProjectionCheckpointRow = typeof ProjectionCheckpointRow.Type;

export const ProjectionPendingApprovalStatus = Schema.Literals(["pending", "resolved"]);
export type ProjectionPendingApprovalStatus = typeof ProjectionPendingApprovalStatus.Type;

export const ProjectionPendingApprovalDecision = Schema.NullOr(ProviderApprovalDecision);
export type ProjectionPendingApprovalDecision = typeof ProjectionPendingApprovalDecision.Type;

export const OrchestrationThreadSearchSource = Schema.Literals(["user", "assistant"]);
export type OrchestrationThreadSearchSource = typeof OrchestrationThreadSearchSource.Type;

// The server's SQLite client is synchronous and single-connection. Bound both
// scan input and response size so a search cannot monopolize that connection.
export const OrchestrationSearchThreadsInput = Schema.Struct({
  query: TrimmedString.check(Schema.isMinLength(2), Schema.isMaxLength(200)),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type OrchestrationSearchThreadsInput = typeof OrchestrationSearchThreadsInput.Type;

export const OrchestrationThreadSearchMatch = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  snippet: Schema.String.check(Schema.isMaxLength(240)),
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationThreadSearchMatch = typeof OrchestrationThreadSearchMatch.Type;

export const OrchestrationSearchThreadsResult = Schema.Struct({
  matches: Schema.Array(OrchestrationThreadSearchMatch),
});
export type OrchestrationSearchThreadsResult = typeof OrchestrationSearchThreadsResult.Type;

export class OrchestrationSearchThreadsError extends Schema.TaggedErrorClass<OrchestrationSearchThreadsError>()(
  "OrchestrationSearchThreadsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationDispatchCommandError extends Schema.TaggedErrorClass<OrchestrationDispatchCommandError>()(
  "OrchestrationDispatchCommandError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
    bootstrapThreadDisposition: Schema.optional(Schema.Literal("deleted")),
  },
) {}
