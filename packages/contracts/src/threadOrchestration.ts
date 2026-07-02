import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  EnvironmentId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import {
  ModelSelection,
  OrchestrationMessage,
  OrchestrationThreadActivity,
  ProviderInteractionMode,
  RuntimeMode,
} from "./orchestration.ts";
import { ModelCapabilities } from "./model.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export class ThreadOrchestrationError extends Schema.TaggedErrorClass<ThreadOrchestrationError>()(
  "ThreadOrchestrationError",
  {
    operation: TrimmedNonEmptyString,
    code: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    threadId: Schema.optional(ThreadId),
    projectId: Schema.optional(ProjectId),
    resourceType: Schema.optional(TrimmedNonEmptyString),
    resourceId: Schema.optional(TrimmedNonEmptyString),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ThreadOrchestrationProjectSummary = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultModelSelection: Schema.NullOr(ModelSelection),
  updatedAt: IsoDateTime,
});
export type ThreadOrchestrationProjectSummary = typeof ThreadOrchestrationProjectSummary.Type;

export const ThreadOrchestrationListProjectsResult = Schema.Struct({
  projects: Schema.Array(ThreadOrchestrationProjectSummary),
});
export type ThreadOrchestrationListProjectsResult =
  typeof ThreadOrchestrationListProjectsResult.Type;

export const ThreadOrchestrationProviderModelSummary = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  shortName: Schema.optional(TrimmedNonEmptyString),
  subProvider: Schema.optional(TrimmedNonEmptyString),
  isCustom: Schema.Boolean,
  capabilities: Schema.NullOr(ModelCapabilities),
  modelSelection: ModelSelection,
});
export type ThreadOrchestrationProviderModelSummary =
  typeof ThreadOrchestrationProviderModelSummary.Type;

export const ThreadOrchestrationProviderSummary = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  status: TrimmedNonEmptyString,
  authStatus: TrimmedNonEmptyString,
  availability: TrimmedNonEmptyString,
  requiresNewThreadForModelChange: Schema.Boolean,
  models: Schema.Array(ThreadOrchestrationProviderModelSummary),
});
export type ThreadOrchestrationProviderSummary = typeof ThreadOrchestrationProviderSummary.Type;

export const ThreadOrchestrationExecutionTarget = Schema.Struct({
  environment: ExecutionEnvironmentDescriptor,
  hostId: EnvironmentId,
  remoteRouting: Schema.Literal("currentEnvironmentOnly"),
  canCreateLocalThreads: Schema.Boolean,
  canCreateWorktreeThreads: Schema.Boolean,
  providers: Schema.Array(ThreadOrchestrationProviderSummary),
  projects: Schema.Array(ThreadOrchestrationProjectSummary),
  notes: Schema.Array(TrimmedNonEmptyString),
});
export type ThreadOrchestrationExecutionTarget = typeof ThreadOrchestrationExecutionTarget.Type;

export const ThreadOrchestrationListExecutionTargetsResult = Schema.Struct({
  targets: Schema.Array(ThreadOrchestrationExecutionTarget),
});
export type ThreadOrchestrationListExecutionTargetsResult =
  typeof ThreadOrchestrationListExecutionTargetsResult.Type;

export const ThreadOrchestrationListThreadsInput = Schema.Struct({
  query: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(PositiveInt),
});
export type ThreadOrchestrationListThreadsInput = typeof ThreadOrchestrationListThreadsInput.Type;

export const ThreadOrchestrationThreadSummary = Schema.Struct({
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
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadOrchestrationThreadSummary = typeof ThreadOrchestrationThreadSummary.Type;

export const ThreadOrchestrationListThreadsResult = Schema.Struct({
  threads: Schema.Array(ThreadOrchestrationThreadSummary),
});
export type ThreadOrchestrationListThreadsResult = typeof ThreadOrchestrationListThreadsResult.Type;

export const ThreadOrchestrationReadThreadInput = Schema.Struct({
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
  actorThreadId: ThreadId,
  targetThreadId: ThreadId,
  createdAt: IsoDateTime,
});
export type ThreadOrchestrationRelationship = typeof ThreadOrchestrationRelationship.Type;

export const ThreadOrchestrationThreadGraphInput = Schema.Struct({
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
