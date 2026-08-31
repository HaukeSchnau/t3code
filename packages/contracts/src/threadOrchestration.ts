import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  EnvironmentId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  ThreadOrchestrationBatchId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  ModelSelection,
  OrchestrationMessage,
  OrchestrationThreadActivity,
  ProviderInteractionMode,
  RuntimeMode,
} from "./orchestration.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export class ThreadOrchestrationError extends Schema.TaggedErrorClass<ThreadOrchestrationError>()(
  "ThreadOrchestrationError",
  {
    operation: TrimmedNonEmptyString,
    code: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    environmentId: Schema.optional(EnvironmentId),
    threadId: Schema.optional(ThreadId),
    projectId: Schema.optional(ProjectId),
    resourceType: Schema.optional(TrimmedNonEmptyString),
    resourceId: Schema.optional(TrimmedNonEmptyString),
    cause: Schema.optional(Schema.Defect()),
  },
  { httpApiStatus: 400 },
) {}

export const ThreadOrchestrationProjectSummary = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});
export type ThreadOrchestrationProjectSummary = typeof ThreadOrchestrationProjectSummary.Type;

export const ThreadOrchestrationListProjectsResult = Schema.Struct({
  environments: Schema.Array(
    Schema.Struct({
      environmentId: EnvironmentId,
      label: TrimmedNonEmptyString,
      remoteRouting: Schema.Literals(["currentEnvironmentOnly", "registeredRemote"]),
      canCreateLocalThreads: Schema.Boolean,
      canCreateWorktreeThreads: Schema.Boolean,
      projects: Schema.Array(ThreadOrchestrationProjectSummary),
    }),
  ),
});
export type ThreadOrchestrationListProjectsResult =
  typeof ThreadOrchestrationListProjectsResult.Type;

export const ThreadOrchestrationReasoningOption = Schema.Struct({
  optionId: TrimmedNonEmptyString,
  values: Schema.Array(TrimmedNonEmptyString),
  defaultValue: Schema.optional(TrimmedNonEmptyString),
});
export type ThreadOrchestrationReasoningOption = typeof ThreadOrchestrationReasoningOption.Type;

export const ThreadOrchestrationThreadModelChoice = Schema.Struct({
  environmentId: EnvironmentId,
  provider: TrimmedNonEmptyString,
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  model: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  shortName: Schema.optional(TrimmedNonEmptyString),
  reasoning: Schema.optional(ThreadOrchestrationReasoningOption),
  modelSelection: ModelSelection,
});
export type ThreadOrchestrationThreadModelChoice = typeof ThreadOrchestrationThreadModelChoice.Type;

export const ThreadOrchestrationListThreadModelsResult = Schema.Struct({
  models: Schema.Array(ThreadOrchestrationThreadModelChoice),
});
export type ThreadOrchestrationListThreadModelsResult =
  typeof ThreadOrchestrationListThreadModelsResult.Type;

export const ThreadOrchestrationListThreadsInput = Schema.Struct({
  environmentId: Schema.optional(EnvironmentId),
  query: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(PositiveInt),
});
export type ThreadOrchestrationListThreadsInput = typeof ThreadOrchestrationListThreadsInput.Type;

export const ThreadOrchestrationThreadSummary = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  projectTitle: TrimmedNonEmptyString,
  status: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspaceRoot: TrimmedNonEmptyString,
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
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
  backgroundLiveness: Schema.optional(Schema.NullOr(Schema.Literals(["working", "monitoring"]))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadOrchestrationThreadSummary = typeof ThreadOrchestrationThreadSummary.Type;

export const ThreadOrchestrationListThreadsResult = Schema.Struct({
  threads: Schema.Array(ThreadOrchestrationThreadSummary),
});
export type ThreadOrchestrationListThreadsResult = typeof ThreadOrchestrationListThreadsResult.Type;

export const ThreadOrchestrationReadThreadInput = Schema.Struct({
  environmentId: Schema.optional(EnvironmentId),
  threadId: ThreadId,
  turnLimit: Schema.optional(PositiveInt),
});
export type ThreadOrchestrationReadThreadInput = typeof ThreadOrchestrationReadThreadInput.Type;

export const ThreadOrchestrationThreadDetail = Schema.Struct({
  thread: ThreadOrchestrationThreadSummary,
  messages: Schema.Array(OrchestrationMessage),
  activities: Schema.Array(OrchestrationThreadActivity),
  queuedMessageCount: NonNegativeInt,
});
export type ThreadOrchestrationThreadDetail = typeof ThreadOrchestrationThreadDetail.Type;

export const ThreadOrchestrationReadThreadResultInput = Schema.Struct({
  environmentId: Schema.optional(EnvironmentId),
  threadId: ThreadId,
});
export type ThreadOrchestrationReadThreadResultInput =
  typeof ThreadOrchestrationReadThreadResultInput.Type;

export const ThreadOrchestrationThreadResult = Schema.Struct({
  thread: ThreadOrchestrationThreadSummary,
  latestMessage: Schema.NullOr(OrchestrationMessage),
  latestAssistantMessage: Schema.NullOr(OrchestrationMessage),
  queuedMessageCount: NonNegativeInt,
  activityCount: NonNegativeInt,
});
export type ThreadOrchestrationThreadResult = typeof ThreadOrchestrationThreadResult.Type;

export const ThreadOrchestrationAwaitUntil = Schema.Literals(["idle", "completed", "queueDrained"]);
export type ThreadOrchestrationAwaitUntil = typeof ThreadOrchestrationAwaitUntil.Type;

export const ThreadOrchestrationAwaitThreadInput = Schema.Struct({
  environmentId: Schema.optional(EnvironmentId),
  threadId: ThreadId,
  until: Schema.optional(ThreadOrchestrationAwaitUntil),
  timeoutMs: Schema.optional(PositiveInt),
  pollIntervalMs: Schema.optional(PositiveInt),
});
export type ThreadOrchestrationAwaitThreadInput = typeof ThreadOrchestrationAwaitThreadInput.Type;

export const ThreadOrchestrationAwaitThreadResult = Schema.Struct({
  result: ThreadOrchestrationThreadResult,
  satisfied: Schema.Boolean,
  timedOut: Schema.Boolean,
});
export type ThreadOrchestrationAwaitThreadResult = typeof ThreadOrchestrationAwaitThreadResult.Type;

export const ThreadOrchestrationCreateEnvironment = Schema.Union([
  Schema.Struct({ type: Schema.Literal("local") }),
  Schema.Struct({ type: Schema.Literal("worktree") }),
]);
export type ThreadOrchestrationCreateEnvironment = typeof ThreadOrchestrationCreateEnvironment.Type;

export const ThreadOrchestrationCreateTarget = Schema.Struct({
  type: Schema.optional(Schema.Literal("project")),
  environmentId: Schema.optional(EnvironmentId),
  projectId: Schema.optional(ProjectId),
  environment: Schema.optional(ThreadOrchestrationCreateEnvironment),
});
export type ThreadOrchestrationCreateTarget = typeof ThreadOrchestrationCreateTarget.Type;

export const ThreadOrchestrationCreateThreadInput = Schema.Struct({
  prompt: TrimmedNonEmptyString,
  target: Schema.optional(ThreadOrchestrationCreateTarget),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  title: Schema.optional(TrimmedNonEmptyString),
});
export type ThreadOrchestrationCreateThreadInput = typeof ThreadOrchestrationCreateThreadInput.Type;

export const ThreadOrchestrationCreateThreadResult = Schema.Struct({
  thread: ThreadOrchestrationThreadSummary,
  promptSubmitted: Schema.Boolean,
});
export type ThreadOrchestrationCreateThreadResult =
  typeof ThreadOrchestrationCreateThreadResult.Type;

export const ThreadOrchestrationBatchWorkerInput = Schema.Struct({
  label: TrimmedNonEmptyString,
  prompt: Schema.optional(TrimmedNonEmptyString),
  target: Schema.optional(ThreadOrchestrationCreateTarget),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  title: Schema.optional(TrimmedNonEmptyString),
});
export type ThreadOrchestrationBatchWorkerInput = typeof ThreadOrchestrationBatchWorkerInput.Type;

export const ThreadOrchestrationCreateBatchInput = Schema.Struct({
  prompt: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedNonEmptyString),
  workers: Schema.Array(ThreadOrchestrationBatchWorkerInput).check(Schema.isMinLength(1)),
  timeoutMs: Schema.optional(PositiveInt),
});
export type ThreadOrchestrationCreateBatchInput = typeof ThreadOrchestrationCreateBatchInput.Type;

export const ThreadOrchestrationBatchMember = Schema.Struct({
  label: TrimmedNonEmptyString,
  workspaceIsolation: Schema.Literals(["shared", "worktree"]),
  outcome: Schema.Literals([
    "unknown",
    "queued",
    "running",
    "completed",
    "failed",
    "interrupted",
    "blocked-approval",
    "blocked-input",
  ]),
  thread: ThreadOrchestrationThreadSummary,
  latestAssistantMessage: Schema.NullOr(OrchestrationMessage),
  queuedMessageCount: NonNegativeInt,
});
export type ThreadOrchestrationBatchMember = typeof ThreadOrchestrationBatchMember.Type;

export const ThreadOrchestrationBatchStatus = Schema.Literals([
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "deadline-exceeded",
]);
export type ThreadOrchestrationBatchStatus = typeof ThreadOrchestrationBatchStatus.Type;

export const ThreadOrchestrationBatch = Schema.Struct({
  batchId: ThreadOrchestrationBatchId,
  coordinatorEnvironmentId: EnvironmentId,
  coordinatorThreadId: ThreadId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  status: ThreadOrchestrationBatchStatus,
  members: Schema.Array(ThreadOrchestrationBatchMember),
  createdAt: IsoDateTime,
  deadlineAt: Schema.NullOr(IsoDateTime),
  settledAt: Schema.NullOr(IsoDateTime),
  notifiedAt: Schema.NullOr(IsoDateTime),
});
export type ThreadOrchestrationBatch = typeof ThreadOrchestrationBatch.Type;

export const ThreadOrchestrationCreateBatchResult = Schema.Struct({
  batch: ThreadOrchestrationBatch,
});
export type ThreadOrchestrationCreateBatchResult = typeof ThreadOrchestrationCreateBatchResult.Type;

export const ThreadOrchestrationReadBatchInput = Schema.Struct({
  batchId: ThreadOrchestrationBatchId,
});
export type ThreadOrchestrationReadBatchInput = typeof ThreadOrchestrationReadBatchInput.Type;

export const ThreadOrchestrationAwaitBatchInput = Schema.Struct({
  batchId: ThreadOrchestrationBatchId,
  timeoutMs: Schema.optional(PositiveInt),
});
export type ThreadOrchestrationAwaitBatchInput = typeof ThreadOrchestrationAwaitBatchInput.Type;

export const ThreadOrchestrationAwaitBatchResult = Schema.Struct({
  batch: ThreadOrchestrationBatch,
  satisfied: Schema.Boolean,
  timedOut: Schema.Boolean,
});
export type ThreadOrchestrationAwaitBatchResult = typeof ThreadOrchestrationAwaitBatchResult.Type;

export const ThreadOrchestrationCancelBatchInput = Schema.Struct({
  batchId: ThreadOrchestrationBatchId,
});
export type ThreadOrchestrationCancelBatchInput = typeof ThreadOrchestrationCancelBatchInput.Type;

export const ThreadOrchestrationCleanupBatchInput = Schema.Struct({
  batchId: ThreadOrchestrationBatchId,
});
export type ThreadOrchestrationCleanupBatchInput = typeof ThreadOrchestrationCleanupBatchInput.Type;

export const ThreadOrchestrationCleanupBatchResult = Schema.Struct({
  batch: ThreadOrchestrationBatch,
  deletedWorkspaceCount: NonNegativeInt,
});
export type ThreadOrchestrationCleanupBatchResult =
  typeof ThreadOrchestrationCleanupBatchResult.Type;

export const ThreadOrchestrationForkThreadInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  environment: Schema.optional(
    Schema.Union([
      Schema.Struct({ type: Schema.Literal("same-directory") }),
      Schema.Struct({ type: Schema.Literal("worktree") }),
    ]),
  ),
});
export type ThreadOrchestrationForkThreadInput = typeof ThreadOrchestrationForkThreadInput.Type;

export const ThreadOrchestrationForkThreadResult = Schema.Struct({
  thread: ThreadOrchestrationThreadSummary,
  transcriptCloned: Schema.Boolean,
});
export type ThreadOrchestrationForkThreadResult = typeof ThreadOrchestrationForkThreadResult.Type;

export const ThreadOrchestrationSendMessageInput = Schema.Struct({
  environmentId: Schema.optional(EnvironmentId),
  threadId: ThreadId,
  prompt: TrimmedNonEmptyString,
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type ThreadOrchestrationSendMessageInput = typeof ThreadOrchestrationSendMessageInput.Type;

export const ThreadOrchestrationSendMessageResult = Schema.Struct({
  thread: ThreadOrchestrationThreadSummary,
  queued: Schema.Boolean,
});
export type ThreadOrchestrationSendMessageResult = typeof ThreadOrchestrationSendMessageResult.Type;

export const ThreadOrchestrationSetThreadTitleInput = Schema.Struct({
  environmentId: Schema.optional(EnvironmentId),
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
});
export type ThreadOrchestrationSetThreadTitleInput =
  typeof ThreadOrchestrationSetThreadTitleInput.Type;

export const ThreadOrchestrationRelationshipKind = Schema.Literals([
  "createdBy",
  "forkedFrom",
  "readBy",
  "messagedBy",
  "renamedBy",
]);
export type ThreadOrchestrationRelationshipKind = typeof ThreadOrchestrationRelationshipKind.Type;

export const ThreadOrchestrationRelationship = Schema.Struct({
  kind: ThreadOrchestrationRelationshipKind,
  actorEnvironmentId: Schema.optional(EnvironmentId),
  actorThreadId: ThreadId,
  targetEnvironmentId: Schema.optional(EnvironmentId),
  targetThreadId: ThreadId,
  batchId: Schema.optional(ThreadOrchestrationBatchId),
  createdAt: IsoDateTime,
});
export type ThreadOrchestrationRelationship = typeof ThreadOrchestrationRelationship.Type;

export const ThreadOrchestrationThreadGraphInput = Schema.Struct({
  environmentId: Schema.optional(EnvironmentId),
  rootThreadId: Schema.optional(ThreadId),
  includeReadEdges: Schema.optional(Schema.Boolean),
  depth: Schema.optional(PositiveInt),
  limit: Schema.optional(PositiveInt),
});
export type ThreadOrchestrationThreadGraphInput = typeof ThreadOrchestrationThreadGraphInput.Type;

export const ThreadOrchestrationThreadGraphResult = Schema.Struct({
  nodes: Schema.Array(ThreadOrchestrationThreadSummary),
  edges: Schema.Array(ThreadOrchestrationRelationship),
});
export type ThreadOrchestrationThreadGraphResult = typeof ThreadOrchestrationThreadGraphResult.Type;

export const ThreadOrchestrationActorScope = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  providerSessionId: TrimmedNonEmptyString,
  providerInstanceId: ProviderInstanceId,
});
export type ThreadOrchestrationActorScope = typeof ThreadOrchestrationActorScope.Type;

export const ThreadOrchestrationScopedListThreadsInput = Schema.Struct({
  scope: ThreadOrchestrationActorScope,
  input: ThreadOrchestrationListThreadsInput,
});
export type ThreadOrchestrationScopedListThreadsInput =
  typeof ThreadOrchestrationScopedListThreadsInput.Type;

export const ThreadOrchestrationScopedReadThreadInput = Schema.Struct({
  scope: ThreadOrchestrationActorScope,
  input: ThreadOrchestrationReadThreadInput,
});
export type ThreadOrchestrationScopedReadThreadInput =
  typeof ThreadOrchestrationScopedReadThreadInput.Type;

export const ThreadOrchestrationScopedReadThreadResultInput = Schema.Struct({
  scope: ThreadOrchestrationActorScope,
  input: ThreadOrchestrationReadThreadResultInput,
});
export type ThreadOrchestrationScopedReadThreadResultInput =
  typeof ThreadOrchestrationScopedReadThreadResultInput.Type;

export const ThreadOrchestrationScopedAwaitThreadInput = Schema.Struct({
  scope: ThreadOrchestrationActorScope,
  input: ThreadOrchestrationAwaitThreadInput,
});
export type ThreadOrchestrationScopedAwaitThreadInput =
  typeof ThreadOrchestrationScopedAwaitThreadInput.Type;

export const ThreadOrchestrationScopedThreadGraphInput = Schema.Struct({
  scope: ThreadOrchestrationActorScope,
  input: ThreadOrchestrationThreadGraphInput,
});
export type ThreadOrchestrationScopedThreadGraphInput =
  typeof ThreadOrchestrationScopedThreadGraphInput.Type;

export const ThreadOrchestrationScopedCreateThreadInput = Schema.Struct({
  scope: ThreadOrchestrationActorScope,
  input: ThreadOrchestrationCreateThreadInput,
});
export type ThreadOrchestrationScopedCreateThreadInput =
  typeof ThreadOrchestrationScopedCreateThreadInput.Type;

export const ThreadOrchestrationScopedCreateBatchInput = Schema.Struct({
  scope: ThreadOrchestrationActorScope,
  input: ThreadOrchestrationCreateBatchInput,
});
export type ThreadOrchestrationScopedCreateBatchInput =
  typeof ThreadOrchestrationScopedCreateBatchInput.Type;

export const ThreadOrchestrationScopedReadBatchInput = Schema.Struct({
  scope: ThreadOrchestrationActorScope,
  input: ThreadOrchestrationReadBatchInput,
});
export type ThreadOrchestrationScopedReadBatchInput =
  typeof ThreadOrchestrationScopedReadBatchInput.Type;

export const ThreadOrchestrationScopedAwaitBatchInput = Schema.Struct({
  scope: ThreadOrchestrationActorScope,
  input: ThreadOrchestrationAwaitBatchInput,
});
export type ThreadOrchestrationScopedAwaitBatchInput =
  typeof ThreadOrchestrationScopedAwaitBatchInput.Type;

export const ThreadOrchestrationScopedCancelBatchInput = Schema.Struct({
  scope: ThreadOrchestrationActorScope,
  input: ThreadOrchestrationCancelBatchInput,
});
export type ThreadOrchestrationScopedCancelBatchInput =
  typeof ThreadOrchestrationScopedCancelBatchInput.Type;

export const ThreadOrchestrationScopedCleanupBatchInput = Schema.Struct({
  scope: ThreadOrchestrationActorScope,
  input: ThreadOrchestrationCleanupBatchInput,
});
export type ThreadOrchestrationScopedCleanupBatchInput =
  typeof ThreadOrchestrationScopedCleanupBatchInput.Type;

export const ThreadOrchestrationScopedForkThreadInput = Schema.Struct({
  scope: ThreadOrchestrationActorScope,
  input: ThreadOrchestrationForkThreadInput,
});
export type ThreadOrchestrationScopedForkThreadInput =
  typeof ThreadOrchestrationScopedForkThreadInput.Type;

export const ThreadOrchestrationScopedSendMessageInput = Schema.Struct({
  scope: ThreadOrchestrationActorScope,
  input: ThreadOrchestrationSendMessageInput,
});
export type ThreadOrchestrationScopedSendMessageInput =
  typeof ThreadOrchestrationScopedSendMessageInput.Type;

export const ThreadOrchestrationScopedSetThreadTitleInput = Schema.Struct({
  scope: ThreadOrchestrationActorScope,
  input: ThreadOrchestrationSetThreadTitleInput,
});
export type ThreadOrchestrationScopedSetThreadTitleInput =
  typeof ThreadOrchestrationScopedSetThreadTitleInput.Type;
