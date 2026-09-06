import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProviderInstanceId,
  type ProjectId,
  type ModelSelection,
  ThreadId,
  ThreadOrchestrationBatchId,
  ThreadOrchestrationEffortId,
  ThreadOrchestrationWaitId,
  ThreadOrchestrationWatchId,
  ThreadOrchestrationError,
  type OrchestrationEffortShell,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type OrchestrationThreadRef,
  type OrchestrationWaitShell,
  type OrchestrationWatchShell,
  type ThreadOrchestrationActorScope,
  type ThreadOrchestrationBatch,
  type ThreadOrchestrationBatchStatus,
  type ThreadOrchestrationCancelBatchInput,
  type ThreadOrchestrationCleanupBatchInput,
  type ThreadOrchestrationCleanupBatchResult,
  type ThreadOrchestrationCreateEffortInput,
  type ThreadOrchestrationReadEffortInput,
  type ThreadOrchestrationListEffortsInput,
  type ThreadOrchestrationListEffortsResult,
  type ThreadOrchestrationRenameEffortInput,
  type ThreadOrchestrationCloseEffortInput,
  type ThreadOrchestrationReopenEffortInput,
  type ThreadOrchestrationAddEffortMemberInput,
  type ThreadOrchestrationRemoveEffortMemberInput,
  type ThreadOrchestrationCreateWaitInput,
  type ThreadOrchestrationReadWaitInput,
  type ThreadOrchestrationListWaitsInput,
  type ThreadOrchestrationListWaitsResult,
  type ThreadOrchestrationCancelWaitInput,
  type ThreadOrchestrationCreateWatchInput,
  type ThreadOrchestrationReadWatchInput,
  type ThreadOrchestrationListWatchesInput,
  type ThreadOrchestrationListWatchesResult,
  type ThreadOrchestrationCancelWatchInput,
  type ThreadOrchestrationStopThreadInput,
  type ThreadOrchestrationCreateBatchInput,
  type ThreadOrchestrationCreateBatchResult,
  type ThreadOrchestrationCreateThreadInput,
  type ThreadOrchestrationCreateThreadResult,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadOrchestrationForkThreadInput,
  type ThreadOrchestrationForkThreadResult,
  type ThreadOrchestrationListProjectsResult,
  type ThreadOrchestrationListThreadModelsResult,
  type ThreadOrchestrationListThreadsInput,
  type ThreadOrchestrationListThreadsResult,
  type ThreadOrchestrationReadThreadInput,
  type ThreadOrchestrationReadBatchInput,
  type ThreadOrchestrationReadThreadResultInput,
  type ThreadOrchestrationReasoningOption,
  type ThreadOrchestrationRelationship,
  type ThreadOrchestrationRelationshipKind,
  type ThreadOrchestrationSendMessageInput,
  type ThreadOrchestrationSendMessageResult,
  type ThreadOrchestrationSetThreadTitleInput,
  type ThreadOrchestrationThreadGraphInput,
  type ThreadOrchestrationThreadGraphResult,
  type ThreadOrchestrationThreadDetail,
  type ThreadMessageDelivery,
  type ThreadOrchestrationThreadModelChoice,
  type ThreadOrchestrationThreadResult,
  type ThreadOrchestrationThreadSummary,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ThreadWorkspaceService from "../../../workspace/ThreadWorkspaceService.ts";
import { generateBootstrapWorkspaceNaming } from "../../../workspace/BootstrapWorkspaceNaming.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as TextGeneration from "../../../textGeneration/TextGeneration.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionThreadResultContext,
} from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import type * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CodexThreadForkImporter } from "./CodexThreadForkImporter.ts";
import { RemoteThreadOrchestrationClient } from "./RemoteThreadOrchestrationClient.ts";
import {
  makeWatchChangeGate,
  makeWatchFloodGate,
  makeWatchShutdownGuard,
  runWatchSource,
  WatchSourceError,
} from "./WatchRuntime.ts";

const DEFAULT_THREAD_LIMIT = 20;
const MAX_THREAD_LIMIT = 100;
const MAX_BATCH_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1_000;

const HIDDEN_THREAD_MODEL_SLUGS = new Set([
  "gpt-5.3-codex-spark",
  "gpt-5.4-mini",
  "gpt-5.4-mini-fast",
]);

const HIDDEN_THREAD_MODEL_PATTERNS = [
  /(?:^|[-_/])(deprecated|legacy|internal|experimental|spark|mini)(?:$|[-_/])/i,
];

type ResolvedCreateThreadInput = Omit<
  ThreadOrchestrationCreateThreadInput,
  "modelSelection" | "runtimeMode" | "interactionMode"
> & {
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
};

export class ThreadOrchestrationService extends Context.Service<
  ThreadOrchestrationService,
  {
    readonly listProjects: () => Effect.Effect<
      ThreadOrchestrationListProjectsResult,
      ThreadOrchestrationError
    >;
    readonly listThreadModels: () => Effect.Effect<
      ThreadOrchestrationListThreadModelsResult,
      ThreadOrchestrationError
    >;
    readonly listLocalProjects: () => Effect.Effect<
      ThreadOrchestrationListProjectsResult,
      ThreadOrchestrationError
    >;
    readonly listLocalThreadModels: () => Effect.Effect<
      ThreadOrchestrationListThreadModelsResult,
      ThreadOrchestrationError
    >;
    readonly listThreads: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationListThreadsInput,
    ) => Effect.Effect<ThreadOrchestrationListThreadsResult, ThreadOrchestrationError>;
    readonly readThread: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationReadThreadInput,
    ) => Effect.Effect<ThreadOrchestrationThreadDetail, ThreadOrchestrationError>;
    readonly readThreadResult: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationReadThreadResultInput,
    ) => Effect.Effect<ThreadOrchestrationThreadResult, ThreadOrchestrationError>;
    readonly getThreadGraph: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationThreadGraphInput,
    ) => Effect.Effect<ThreadOrchestrationThreadGraphResult, ThreadOrchestrationError>;
    readonly createThread: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationCreateThreadInput,
    ) => Effect.Effect<ThreadOrchestrationCreateThreadResult, ThreadOrchestrationError>;
    readonly createRootThread: (
      input: ThreadOrchestrationCreateThreadInput,
    ) => Effect.Effect<ThreadOrchestrationCreateThreadResult, ThreadOrchestrationError>;
    readonly createBatch: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationCreateBatchInput,
    ) => Effect.Effect<ThreadOrchestrationCreateBatchResult, ThreadOrchestrationError>;
    readonly readBatch: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationReadBatchInput,
    ) => Effect.Effect<ThreadOrchestrationBatch, ThreadOrchestrationError>;
    readonly cancelBatch: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationCancelBatchInput,
    ) => Effect.Effect<ThreadOrchestrationBatch, ThreadOrchestrationError>;
    readonly cleanupBatch: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationCleanupBatchInput,
    ) => Effect.Effect<ThreadOrchestrationCleanupBatchResult, ThreadOrchestrationError>;
    readonly createEffort: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationCreateEffortInput,
    ) => Effect.Effect<OrchestrationEffortShell, ThreadOrchestrationError>;
    readonly readEffort: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationReadEffortInput,
    ) => Effect.Effect<OrchestrationEffortShell, ThreadOrchestrationError>;
    readonly listEfforts: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationListEffortsInput,
    ) => Effect.Effect<ThreadOrchestrationListEffortsResult, ThreadOrchestrationError>;
    readonly renameEffort: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationRenameEffortInput,
    ) => Effect.Effect<OrchestrationEffortShell, ThreadOrchestrationError>;
    readonly closeEffort: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationCloseEffortInput,
    ) => Effect.Effect<OrchestrationEffortShell, ThreadOrchestrationError>;
    readonly reopenEffort: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationReopenEffortInput,
    ) => Effect.Effect<OrchestrationEffortShell, ThreadOrchestrationError>;
    readonly addEffortMember: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationAddEffortMemberInput,
    ) => Effect.Effect<OrchestrationEffortShell, ThreadOrchestrationError>;
    readonly removeEffortMember: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationRemoveEffortMemberInput,
    ) => Effect.Effect<OrchestrationEffortShell, ThreadOrchestrationError>;
    readonly createWait: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationCreateWaitInput,
    ) => Effect.Effect<OrchestrationWaitShell, ThreadOrchestrationError>;
    readonly readWait: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationReadWaitInput,
    ) => Effect.Effect<OrchestrationWaitShell, ThreadOrchestrationError>;
    readonly listWaits: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationListWaitsInput,
    ) => Effect.Effect<ThreadOrchestrationListWaitsResult, ThreadOrchestrationError>;
    readonly cancelWait: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationCancelWaitInput,
    ) => Effect.Effect<OrchestrationWaitShell, ThreadOrchestrationError>;
    readonly createWatch: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationCreateWatchInput,
    ) => Effect.Effect<OrchestrationWatchShell, ThreadOrchestrationError>;
    readonly readWatch: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationReadWatchInput,
    ) => Effect.Effect<OrchestrationWatchShell, ThreadOrchestrationError>;
    readonly listWatches: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationListWatchesInput,
    ) => Effect.Effect<ThreadOrchestrationListWatchesResult, ThreadOrchestrationError>;
    readonly cancelWatch: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationCancelWatchInput,
    ) => Effect.Effect<OrchestrationWatchShell, ThreadOrchestrationError>;
    readonly stopThread: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationStopThreadInput,
    ) => Effect.Effect<ThreadOrchestrationThreadSummary, ThreadOrchestrationError>;
    readonly createThreadFromRemote: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationCreateThreadInput,
    ) => Effect.Effect<ThreadOrchestrationCreateThreadResult, ThreadOrchestrationError>;
    readonly forkThread: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationForkThreadInput,
    ) => Effect.Effect<ThreadOrchestrationForkThreadResult, ThreadOrchestrationError>;
    readonly sendMessageToThread: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationSendMessageInput,
    ) => Effect.Effect<ThreadOrchestrationSendMessageResult, ThreadOrchestrationError>;
    readonly setThreadTitle: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationSetThreadTitleInput,
    ) => Effect.Effect<ThreadOrchestrationThreadSummary, ThreadOrchestrationError>;
  }
>()("t3/mcp/toolkits/thread-orchestration/service/ThreadOrchestrationService") {}

const toThreadOrchestrationError =
  (
    operation: string,
    input: { readonly threadId?: ThreadId; readonly projectId?: ProjectId } = {},
  ) =>
  (cause: unknown) =>
    new ThreadOrchestrationError({
      operation,
      code: "operation_failed",
      message: `Thread orchestration operation '${operation}' failed.`,
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      cause,
    });

const notFoundError = (
  operation: string,
  resourceType: "thread" | "project",
  resourceId: string,
  input: { readonly threadId?: ThreadId; readonly projectId?: ProjectId } = {},
) =>
  new ThreadOrchestrationError({
    operation,
    code: "not_found",
    message: `${resourceType === "thread" ? "Thread" : "Project"} '${resourceId}' was not found.`,
    resourceType,
    resourceId,
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
  });

const isUnsupportedCodexForkSource = (error: ThreadOrchestrationError) =>
  error.operation === "fork_thread.codex" && error.code === "unsupported_source";

const compareUpdatedDesc = (
  left: { readonly updatedAt: string },
  right: { readonly updatedAt: string },
) => right.updatedAt.localeCompare(left.updatedAt);

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const makeId = <A>(crypto: Crypto.Crypto, prefix: string, make: (value: string) => A) =>
  crypto.randomUUIDv4.pipe(
    Effect.map((uuid) => make(`${prefix}:${uuid}`)),
    Effect.orDie,
  );

type ThreadSummarySource = OrchestrationThread | OrchestrationThreadShell;
type ProjectSummarySource = OrchestrationProjectShell;

type StoredBatchMember = {
  readonly label: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceIsolation: "shared" | "worktree";
};

type StoredBatchDefinition = {
  readonly batchId: ThreadOrchestrationBatchId;
  readonly coordinatorEnvironmentId: EnvironmentId;
  readonly coordinatorThreadId: ThreadId;
  readonly title: string;
  readonly prompt: string;
  readonly members: ReadonlyArray<StoredBatchMember>;
  readonly createdAt: string;
  readonly deadlineAt: string | null;
};

function batchDefinitionFromActivity(
  activity: OrchestrationThreadActivity,
): StoredBatchDefinition | null {
  if (activity.kind !== "thread-orchestration.batch.created") return null;
  const candidate = activity.payload as Partial<StoredBatchDefinition> | null | undefined;
  if (
    candidate == null ||
    typeof candidate.batchId !== "string" ||
    typeof candidate.coordinatorEnvironmentId !== "string" ||
    typeof candidate.coordinatorThreadId !== "string" ||
    typeof candidate.title !== "string" ||
    typeof candidate.prompt !== "string" ||
    !Array.isArray(candidate.members) ||
    typeof candidate.createdAt !== "string"
  ) {
    return null;
  }
  const members = candidate.members.flatMap((member) =>
    typeof member?.label === "string" &&
    typeof member.environmentId === "string" &&
    typeof member.threadId === "string"
      ? [
          {
            label: member.label,
            environmentId: EnvironmentId.make(member.environmentId),
            threadId: ThreadId.make(member.threadId),
            workspaceIsolation:
              member.workspaceIsolation === "worktree"
                ? ("worktree" as const)
                : ("shared" as const),
          },
        ]
      : [],
  );
  if (members.length !== candidate.members.length) return null;
  return {
    batchId: ThreadOrchestrationBatchId.make(candidate.batchId),
    coordinatorEnvironmentId: EnvironmentId.make(candidate.coordinatorEnvironmentId),
    coordinatorThreadId: ThreadId.make(candidate.coordinatorThreadId),
    title: candidate.title,
    prompt: candidate.prompt,
    members,
    createdAt: candidate.createdAt,
    deadlineAt: typeof candidate.deadlineAt === "string" ? candidate.deadlineAt : null,
  };
}

function hasBatchActivity(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  kind: string,
  batchId: ThreadOrchestrationBatchId,
): OrchestrationThreadActivity | undefined {
  return activities.find(
    (activity) =>
      activity.kind === kind &&
      typeof activity.payload === "object" &&
      activity.payload !== null &&
      (activity.payload as { readonly batchId?: unknown }).batchId === batchId,
  );
}

function isTerminalBatchMemberOutcome(
  outcome: NonNullable<ThreadOrchestrationThreadSummary["outcome"]>,
): boolean {
  return ["completed", "failed", "interrupted"].includes(outcome);
}

function isTerminalBatchStatus(status: ThreadOrchestrationBatchStatus): boolean {
  return ["completed", "failed", "cancelled", "deadline-exceeded"].includes(status);
}

function deliveryForCoordinatorNotification(
  outcomes: ReadonlyArray<ThreadOrchestrationThreadSummary["outcome"]>,
  source: "worker-status" | "wait" = "worker-status",
): ThreadMessageDelivery {
  if (source === "wait") return "immediate";
  return outcomes.some((outcome) =>
    ["failed", "blocked-approval", "blocked-input"].includes(outcome ?? "unknown"),
  )
    ? "immediate"
    : "queued";
}

function statusForBatch(input: {
  readonly cancelled: boolean;
  readonly deadlineExceeded: boolean;
  readonly outcomes: ReadonlyArray<NonNullable<ThreadOrchestrationThreadSummary["outcome"]>>;
}): ThreadOrchestrationBatchStatus {
  if (input.cancelled) return "cancelled";
  if (input.deadlineExceeded) return "deadline-exceeded";
  if (input.outcomes.every(isTerminalBatchMemberOutcome)) {
    return input.outcomes.every((outcome) => outcome === "completed") ? "completed" : "failed";
  }
  return input.outcomes.some((outcome) => ["blocked-approval", "blocked-input"].includes(outcome))
    ? "blocked"
    : "running";
}

function statusForThread(thread: ThreadSummarySource): string {
  if ("deletedAt" in thread && thread.deletedAt !== null) return "deleted";
  if (thread.archivedAt !== null) return "archived";
  if (thread.session !== null) return thread.session.status;
  if (thread.latestTurn !== null) return thread.latestTurn.state;
  return "idle";
}

function outcomeForThread(
  thread: ThreadSummarySource,
): NonNullable<ThreadOrchestrationThreadSummary["outcome"]> {
  if ("hasPendingUserInput" in thread && thread.hasPendingUserInput) return "blocked-input";
  if ("hasPendingApprovals" in thread && thread.hasPendingApprovals) return "blocked-approval";
  if (
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.latestTurn?.state === "running" ||
    ("backgroundLiveness" in thread && thread.backgroundLiveness != null)
  ) {
    return "running";
  }
  switch (thread.latestTurn?.state) {
    case "completed":
      return "completed";
    case "error":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return "queued";
  }
}

function failureForThread(
  thread: OrchestrationThreadShell,
): ThreadOrchestrationThreadResult["failure"] {
  const session = thread.session;
  if (session?.status !== "error" || session.lastError === null) return null;
  if (session.providerUnavailable) return session.providerUnavailable;
  return {
    type: "runtime_error",
    reason: session.lastError,
    errorClass: session.lastErrorClass ?? "unknown",
  };
}

function forkSourceBusyReason(context: ProjectionThreadResultContext): string | null {
  const thread = context.thread;
  if (thread.archivedAt !== null) return "archived";
  if (context.queuedMessageCount > 0) return `${context.queuedMessageCount} queued message(s)`;
  if (thread.session?.status === "starting" || thread.session?.status === "running") {
    return `session is ${thread.session.status}`;
  }
  if (thread.session?.activeTurnId !== null && thread.session?.activeTurnId !== undefined) {
    return "session has an active turn";
  }
  if (thread.latestTurn?.state === "running" || thread.latestTurn?.state === "interrupted") {
    return `latest turn is ${thread.latestTurn.state}`;
  }
  return null;
}

function summaryForThread(
  thread: ThreadSummarySource,
  project: ProjectSummarySource,
  environmentId: EnvironmentId,
): ThreadOrchestrationThreadSummary {
  return {
    environmentId,
    threadId: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    projectTitle: project.title,
    status: statusForThread(thread),
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    workspaceRoot: project.workspaceRoot,
    worktreePath: thread.worktreePath,
    outcome: outcomeForThread(thread),
    backgroundLiveness: "backgroundLiveness" in thread ? (thread.backgroundLiveness ?? null) : null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

function trimMessagesForTurns(
  thread: OrchestrationThread,
  turnLimit: number | undefined,
): OrchestrationThread["messages"] {
  if (turnLimit === undefined) return thread.messages;
  let remainingUsers = turnLimit;
  let startIndex = thread.messages.length;
  while (startIndex > 0 && remainingUsers > 0) {
    startIndex -= 1;
    if (thread.messages[startIndex]?.role === "user") {
      remainingUsers -= 1;
    }
  }
  return thread.messages.slice(startIndex);
}

function isHiddenThreadModel(model: string): boolean {
  const slug = model.split("/").at(-1) ?? model;
  if (HIDDEN_THREAD_MODEL_SLUGS.has(model) || HIDDEN_THREAD_MODEL_SLUGS.has(slug)) return true;
  return HIDDEN_THREAD_MODEL_PATTERNS.some((pattern) => pattern.test(model) || pattern.test(slug));
}

function providerDisplayName(provider: ServerProvider): string {
  return provider.displayName ?? provider.driver;
}

function providerIsSelectable(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    provider.status !== "disabled" &&
    provider.availability !== "unavailable" &&
    provider.auth.status !== "unauthenticated"
  );
}

function reasoningOptionForModel(
  model: ServerProviderModel,
): ThreadOrchestrationReasoningOption | undefined {
  const descriptor = model.capabilities?.optionDescriptors?.find(
    (descriptor) =>
      descriptor.type === "select" &&
      ["reasoningEffort", "reasoning", "effort"].includes(descriptor.id),
  );
  if (!descriptor || descriptor.type !== "select") return undefined;
  const values = descriptor.options.map((option) => option.id);
  if (values.length === 0) return undefined;
  const defaultValue =
    descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id;
  return {
    optionId: descriptor.id,
    values,
    ...(defaultValue !== undefined ? { defaultValue } : {}),
  };
}

function modelChoiceForProvider(
  environmentId: EnvironmentId,
  provider: ServerProvider,
  model: ServerProviderModel,
): ThreadOrchestrationThreadModelChoice | undefined {
  if (!providerIsSelectable(provider) || isHiddenThreadModel(model.slug)) return undefined;
  const reasoning = reasoningOptionForModel(model);
  return {
    environmentId,
    provider: providerDisplayName(provider),
    providerInstanceId: provider.instanceId,
    driver: provider.driver,
    model: model.slug,
    name: model.name,
    ...(model.shortName !== undefined ? { shortName: model.shortName } : {}),
    ...(model.isLegacy === true ? { isLegacy: true } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    modelSelection: {
      instanceId: provider.instanceId,
      model: model.slug,
    },
  };
}

function assertExplicitModelSelectionAllowed(
  operation: string,
  modelSelection: ModelSelection | undefined,
): Effect.Effect<void, ThreadOrchestrationError> {
  if (modelSelection === undefined || !isHiddenThreadModel(modelSelection.model)) {
    return Effect.void;
  }
  return Effect.fail(
    new ThreadOrchestrationError({
      operation,
      code: "model_not_selectable",
      message: `Model '${modelSelection.model}' is intentionally hidden from thread orchestration. Omit modelSelection to inherit the current thread's model, or choose a model returned by list_thread_models.`,
      resourceType: "model",
      resourceId: modelSelection.model,
    }),
  );
}

function relationshipFromActivity(
  activity: OrchestrationThreadActivity,
): ThreadOrchestrationRelationship | null {
  if (activity.kind !== "thread-orchestration.relationship") {
    return null;
  }
  const payload = activity.payload;
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const candidate = payload as Partial<ThreadOrchestrationRelationship>;
  if (
    typeof candidate.kind !== "string" ||
    typeof candidate.actorThreadId !== "string" ||
    typeof candidate.targetThreadId !== "string" ||
    typeof candidate.createdAt !== "string"
  ) {
    return null;
  }
  return {
    kind: candidate.kind as ThreadOrchestrationRelationshipKind,
    ...(typeof candidate.actorEnvironmentId === "string"
      ? { actorEnvironmentId: EnvironmentId.make(candidate.actorEnvironmentId) }
      : {}),
    actorThreadId: ThreadId.make(candidate.actorThreadId),
    ...(typeof candidate.targetEnvironmentId === "string"
      ? { targetEnvironmentId: EnvironmentId.make(candidate.targetEnvironmentId) }
      : {}),
    targetThreadId: ThreadId.make(candidate.targetThreadId),
    ...(typeof candidate.batchId === "string"
      ? { batchId: ThreadOrchestrationBatchId.make(candidate.batchId) }
      : {}),
    ...(typeof candidate.effortId === "string"
      ? { effortId: ThreadOrchestrationEffortId.make(candidate.effortId) }
      : {}),
    ...(typeof candidate.label === "string" ? { label: candidate.label } : {}),
    ...(typeof candidate.launchTurnId === "string"
      ? { launchTurnId: candidate.launchTurnId }
      : candidate.launchTurnId === null
        ? { launchTurnId: null }
        : {}),
    ...(typeof candidate.wakeCoordinator === "boolean"
      ? { wakeCoordinator: candidate.wakeCoordinator }
      : {}),
    createdAt: candidate.createdAt,
  };
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const workspaceService = yield* ThreadWorkspaceService.ThreadWorkspaceService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const codexThreadForkImporter = yield* CodexThreadForkImporter;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const providerRegistry = yield* ProviderRegistry;
  const remoteClient = yield* RemoteThreadOrchestrationClient;
  const crypto = yield* Crypto.Crypto;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const watchScope = yield* Effect.scope;
  const watchShutdown = yield* makeWatchShutdownGuard();
  const watchFibers = new Map<
    ThreadOrchestrationWatchId,
    Fiber.Fiber<void, ThreadOrchestrationError>
  >();

  const shellSnapshot = snapshotQuery
    .getShellSnapshot()
    .pipe(Effect.mapError(toThreadOrchestrationError("shell_snapshot")));

  const commandId = (tag: string) => makeId(crypto, `thread-orchestration:${tag}`, CommandId.make);
  const eventId = (tag: string) => makeId(crypto, `thread-orchestration:${tag}`, EventId.make);
  const messageId = (tag: string) => makeId(crypto, `thread-orchestration:${tag}`, MessageId.make);
  const threadId = (tag: string) => makeId(crypto, `thread-orchestration:${tag}`, ThreadId.make);
  const localEnvironmentId = serverEnvironment.getDescriptor.pipe(
    Effect.map((descriptor) => descriptor.environmentId),
    Effect.mapError(toThreadOrchestrationError("environment.resolve")),
  );

  const scopeForRemote = (
    scope: McpInvocationContext.McpInvocationScope,
  ): ThreadOrchestrationActorScope => ({
    environmentId: scope.environmentId,
    threadId: scope.threadId,
    providerSessionId: scope.providerSessionId,
    providerInstanceId: scope.providerInstanceId,
  });

  const shouldRouteRemote = (environmentId: EnvironmentId | undefined) =>
    Effect.gen(function* () {
      if (environmentId === undefined) return false;
      return environmentId !== (yield* localEnvironmentId);
    });

  const assertLegacyModelSelectionAllowed = Effect.fn(
    "ThreadOrchestrationService.assertLegacyModelSelectionAllowed",
  )(function* (
    operation: string,
    modelSelection: ModelSelection | undefined,
    allowLegacyModel: boolean | undefined,
  ) {
    if (modelSelection === undefined || allowLegacyModel === true) return;
    const providers = yield* providerRegistry.getProviders.pipe(
      Effect.mapError(toThreadOrchestrationError(`${operation}.models`)),
    );
    const provider = providers.find(
      (candidate) => candidate.instanceId === modelSelection.instanceId,
    );
    const model = provider?.models.find((candidate) => candidate.slug === modelSelection.model);
    if (model?.isLegacy !== true) return;
    return yield* new ThreadOrchestrationError({
      operation,
      code: "legacy_model_not_allowed",
      message: `Model '${modelSelection.model}' is marked legacy. Choose a current model returned by thread model discovery, or set allowLegacyModel=true for an intentional compatibility run.`,
      resourceType: "model",
      resourceId: modelSelection.model,
    });
  });

  const resolveCreateInput = (
    scope: McpInvocationContext.McpInvocationScope | undefined,
    sourceThread: OrchestrationThreadShell | undefined,
    input: ThreadOrchestrationCreateThreadInput,
  ): Effect.Effect<ResolvedCreateThreadInput, ThreadOrchestrationError> =>
    Effect.gen(function* () {
      const selectedModel = input.modelSelection ?? sourceThread?.modelSelection;
      if (selectedModel === undefined) {
        return yield* new ThreadOrchestrationError({
          operation: "create_thread",
          code: "model_selection_required",
          message: "create_thread requires modelSelection when no caller thread supplies one.",
          ...(scope !== undefined ? { threadId: scope.threadId } : {}),
          projectId: input.target?.projectId,
        });
      }
      return {
        ...input,
        modelSelection: selectedModel,
        runtimeMode: input.runtimeMode ?? sourceThread?.runtimeMode ?? "full-access",
        interactionMode: input.interactionMode ?? sourceThread?.interactionMode ?? "default",
        ...(input.skillPackIds !== undefined
          ? { skillPackIds: input.skillPackIds }
          : sourceThread?.skillScope
            ? { skillPackIds: sourceThread.skillScope.packIds }
            : {}),
      };
    });

  const appendRelationship = (input: {
    readonly scope: McpInvocationContext.McpInvocationScope;
    readonly actor?: OrchestrationThreadRef;
    readonly kind: ThreadOrchestrationRelationshipKind;
    readonly targetThreadId: ThreadId;
    readonly summary: string;
    readonly createdAt: string;
    readonly batchId?: ThreadOrchestrationBatchId;
    readonly effortId?: ThreadOrchestrationEffortId;
    readonly label?: string;
    readonly launchTurnId?: string | null;
    readonly wakeCoordinator?: boolean;
    readonly targetEnvironmentId?: EnvironmentId;
    readonly recordOnThreadId?: ThreadId;
  }) =>
    Effect.gen(function* () {
      const activity: OrchestrationThreadActivity = {
        id: yield* eventId("thread-relationship"),
        tone: "tool",
        kind: "thread-orchestration.relationship",
        summary: input.summary,
        payload: {
          kind: input.kind,
          actorEnvironmentId: input.actor?.environmentId ?? input.scope.environmentId,
          actorThreadId: input.actor?.threadId ?? input.scope.threadId,
          targetEnvironmentId: input.targetEnvironmentId ?? (yield* localEnvironmentId),
          targetThreadId: input.targetThreadId,
          ...(input.batchId !== undefined ? { batchId: input.batchId } : {}),
          ...(input.effortId !== undefined ? { effortId: input.effortId } : {}),
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.launchTurnId !== undefined ? { launchTurnId: input.launchTurnId } : {}),
          ...(input.wakeCoordinator !== undefined
            ? { wakeCoordinator: input.wakeCoordinator }
            : {}),
          createdAt: input.createdAt,
        },
        turnId: null,
        createdAt: input.createdAt,
      };
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: yield* commandId("thread-relationship"),
        threadId: input.recordOnThreadId ?? input.targetThreadId,
        activity,
        createdAt: input.createdAt,
      });
    }).pipe(
      Effect.mapError(
        toThreadOrchestrationError("relationship.append", {
          threadId: input.recordOnThreadId ?? input.targetThreadId,
        }),
      ),
    );

  const appendBatchActivity = (input: {
    readonly threadId: ThreadId;
    readonly batchId: ThreadOrchestrationBatchId;
    readonly kind:
      | "thread-orchestration.batch.created"
      | "thread-orchestration.batch.attention"
      | "thread-orchestration.batch.cancelled"
      | "thread-orchestration.batch.settled"
      | "thread-orchestration.batch.notified"
      | "thread-orchestration.batch.cleaned";
    readonly summary: string;
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
  }) =>
    engine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`${input.batchId}:${input.kind}:command`),
        threadId: input.threadId,
        activity: {
          id: EventId.make(`${input.batchId}:${input.kind}`),
          tone: "tool",
          kind: input.kind,
          summary: input.summary,
          payload: { batchId: input.batchId, ...input.payload },
          turnId: null,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      })
      .pipe(Effect.mapError(toThreadOrchestrationError(input.kind, { threadId: input.threadId })));

  const appendCoordinationActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind: string;
    readonly summary: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
    readonly stableId?: string;
  }) => {
    const id = input.stableId ?? `${input.kind}:${input.threadId}:${input.createdAt}`;
    return engine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`${id}:command`),
        threadId: input.threadId,
        activity: {
          id: EventId.make(id),
          tone: "tool",
          kind: input.kind,
          summary: input.summary,
          payload: input.payload,
          turnId: null,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      })
      .pipe(Effect.mapError(toThreadOrchestrationError(input.kind, { threadId: input.threadId })));
  };

  const resolveThreadSummary = (targetThreadId: ThreadId) =>
    Effect.gen(function* () {
      const threadOption = yield* snapshotQuery.getThreadShellById(targetThreadId).pipe(
        Effect.mapError(
          toThreadOrchestrationError("thread.resolve.thread", {
            threadId: targetThreadId,
          }),
        ),
      );
      if (Option.isNone(threadOption)) {
        return yield* notFoundError("thread.resolve", "thread", targetThreadId, {
          threadId: targetThreadId,
        });
      }
      const thread = threadOption.value;
      const projectOption = yield* snapshotQuery.getProjectShellById(thread.projectId).pipe(
        Effect.mapError(
          toThreadOrchestrationError("thread.resolve.project", {
            threadId: targetThreadId,
            projectId: thread.projectId,
          }),
        ),
      );
      if (Option.isNone(projectOption)) {
        return yield* new ThreadOrchestrationError({
          operation: "thread.resolve",
          code: "not_found",
          message: `Project '${thread.projectId}' for thread '${targetThreadId}' was not found.`,
          threadId: targetThreadId,
          projectId: thread.projectId,
          resourceType: "project",
          resourceId: thread.projectId,
        });
      }
      return summaryForThread(thread, projectOption.value, yield* localEnvironmentId);
    });

  const threadResultFromContext = (
    context: ProjectionThreadResultContext,
  ): Effect.Effect<ThreadOrchestrationThreadResult, ThreadOrchestrationError> =>
    Effect.gen(function* () {
      return {
        thread: summaryForThread(context.thread, context.project, yield* localEnvironmentId),
        latestMessage: context.latestMessage,
        latestAssistantMessage: context.latestAssistantMessage,
        queuedMessageCount: context.queuedMessageCount,
        activityCount: context.activityCount,
        failure: failureForThread(context.thread),
      };
    });

  const readThreadResultContext = (
    targetThreadId: ThreadId,
    operation: string,
  ): Effect.Effect<ProjectionThreadResultContext, ThreadOrchestrationError> =>
    Effect.gen(function* () {
      const context = yield* snapshotQuery.getThreadResultContextById(targetThreadId).pipe(
        Effect.mapError(
          toThreadOrchestrationError(`${operation}.result_context`, {
            threadId: targetThreadId,
          }),
        ),
      );
      if (Option.isNone(context)) {
        return yield* notFoundError(operation, "thread", targetThreadId, {
          threadId: targetThreadId,
        });
      }
      return context.value;
    });

  const readThreadResult = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationReadThreadResultInput,
  ) =>
    Effect.gen(function* () {
      if (yield* shouldRouteRemote(input.environmentId)) {
        return yield* remoteClient.readThreadResult(scopeForRemote(scope), input);
      }
      const context = yield* readThreadResultContext(input.threadId, "read_thread_result");
      return yield* threadResultFromContext(context);
    });

  const listLocalProjects = () =>
    Effect.gen(function* () {
      const [model, descriptor] = yield* Effect.all(
        [
          shellSnapshot,
          serverEnvironment.getDescriptor.pipe(
            Effect.mapError(toThreadOrchestrationError("list_projects.environment")),
          ),
        ],
        { concurrency: "unbounded" },
      );
      const projects = model.projects.toSorted(compareUpdatedDesc).map((project) => ({
        projectId: project.id,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        updatedAt: project.updatedAt,
      }));
      return {
        environments: [
          {
            environmentId: descriptor.environmentId,
            label: descriptor.label,
            remoteRouting: "currentEnvironmentOnly" as const,
            canCreateLocalThreads: true,
            canCreateWorktreeThreads: true,
            projects,
          },
        ],
      };
    });

  const listProjects = () =>
    Effect.gen(function* () {
      const [localProjects, remoteProjects] = yield* Effect.all(
        [listLocalProjects(), remoteClient.listProjects()],
        { concurrency: "unbounded" },
      );
      return {
        environments: [
          ...localProjects.environments,
          ...remoteProjects.environments.map((environment) => ({
            ...environment,
            remoteRouting: "registeredRemote" as const,
          })),
        ],
      };
    });

  const listLocalThreadModels = () =>
    Effect.gen(function* () {
      const [environmentId, providers] = yield* Effect.all(
        [
          localEnvironmentId,
          providerRegistry.getProviders.pipe(
            Effect.mapError(toThreadOrchestrationError("list_thread_models.providers")),
          ),
        ],
        { concurrency: "unbounded" },
      );

      const localModels = providers.flatMap((provider) =>
        provider.models.flatMap(
          (model) => modelChoiceForProvider(environmentId, provider, model) ?? [],
        ),
      );
      return {
        models: localModels,
      };
    });

  const listThreadModels = () =>
    Effect.gen(function* () {
      const [localModels, remoteModels] = yield* Effect.all(
        [listLocalThreadModels(), remoteClient.listThreadModels()],
        { concurrency: "unbounded" },
      );
      return {
        models: [...localModels.models, ...remoteModels.models],
      };
    });

  const listThreads = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationListThreadsInput,
  ) =>
    Effect.gen(function* () {
      if (yield* shouldRouteRemote(input.environmentId)) {
        return yield* remoteClient.listThreads(scopeForRemote(scope), input);
      }
      const currentEnvironmentId = yield* localEnvironmentId;
      return yield* shellSnapshot.pipe(
        Effect.map((model) => {
          const environmentId = input.environmentId ?? currentEnvironmentId;
          const query = input.query?.toLowerCase();
          const limit = Math.min(input.limit ?? DEFAULT_THREAD_LIMIT, MAX_THREAD_LIMIT);
          return {
            threads: model.threads
              .filter((thread) => thread.archivedAt === null)
              .flatMap((thread) => {
                const project = model.projects.find(
                  (candidate) => candidate.id === thread.projectId,
                );
                if (!project) return [];
                const summary = summaryForThread(thread, project, environmentId);
                if (
                  query &&
                  !summary.title.toLowerCase().includes(query) &&
                  !summary.projectTitle.toLowerCase().includes(query) &&
                  !summary.workspaceRoot.toLowerCase().includes(query)
                ) {
                  return [];
                }
                return [summary];
              })
              .toSorted(compareUpdatedDesc)
              .slice(0, limit),
          };
        }),
      );
    });

  const readThread = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationReadThreadInput,
  ) =>
    Effect.gen(function* () {
      if (yield* shouldRouteRemote(input.environmentId)) {
        return yield* remoteClient.readThread(scopeForRemote(scope), input);
      }
      const threadOption = yield* snapshotQuery.getThreadDetailById(input.threadId).pipe(
        Effect.mapError(
          toThreadOrchestrationError("read_thread.thread", {
            threadId: input.threadId,
          }),
        ),
      );
      if (Option.isNone(threadOption)) {
        return yield* notFoundError("read_thread", "thread", input.threadId, {
          threadId: input.threadId,
        });
      }
      const thread = threadOption.value;
      const projectOption = yield* snapshotQuery.getProjectShellById(thread.projectId).pipe(
        Effect.mapError(
          toThreadOrchestrationError("read_thread.project", {
            threadId: input.threadId,
            projectId: thread.projectId,
          }),
        ),
      );
      if (Option.isNone(projectOption)) {
        return yield* new ThreadOrchestrationError({
          operation: "read_thread",
          code: "not_found",
          message: `Project '${thread.projectId}' for thread '${input.threadId}' was not found.`,
          threadId: input.threadId,
          projectId: thread.projectId,
          resourceType: "project",
          resourceId: thread.projectId,
        });
      }
      const createdDateTime = yield* DateTime.now;
      const createdAt = DateTime.formatIso(createdDateTime);
      if (input.threadId !== scope.threadId) {
        yield* appendRelationship({
          scope,
          kind: "readBy",
          targetThreadId: input.threadId,
          summary: `Read by thread ${scope.threadId}.`,
          createdAt,
        });
      }
      return {
        thread: summaryForThread(thread, projectOption.value, yield* localEnvironmentId),
        messages: trimMessagesForTurns(thread, input.turnLimit),
        activities: thread.activities,
        queuedMessageCount: thread.queuedMessages?.length ?? 0,
      };
    });

  const getThreadGraph = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationThreadGraphInput,
  ) =>
    Effect.gen(function* () {
      if (yield* shouldRouteRemote(input.environmentId)) {
        return yield* remoteClient.getThreadGraph(scopeForRemote(scope), input);
      }
      const [model, relationshipActivities] = yield* Effect.all(
        [
          shellSnapshot,
          snapshotQuery
            .listThreadRelationshipActivities()
            .pipe(Effect.mapError(toThreadOrchestrationError("get_thread_graph.relationships"))),
        ],
        { concurrency: "unbounded" },
      );
      const currentEnvironmentId = yield* localEnvironmentId;
      const includeReadEdges = input.includeReadEdges ?? false;
      const edgeLimit = Math.min(input.limit ?? MAX_THREAD_LIMIT, MAX_THREAD_LIMIT);
      const depthLimit = input.depth ?? Number.POSITIVE_INFINITY;
      const summaries = new Map<ThreadId, ThreadOrchestrationThreadSummary>();
      const projects = new Map(model.projects.map((project) => [project.id, project]));
      for (const thread of model.threads) {
        const project = projects.get(thread.projectId);
        if (project) {
          summaries.set(thread.id, summaryForThread(thread, project, currentEnvironmentId));
        }
      }
      if (input.rootThreadId !== undefined && !summaries.has(input.rootThreadId)) {
        return yield* notFoundError("get_thread_graph", "thread", input.rootThreadId, {
          threadId: input.rootThreadId,
        });
      }

      const allEdges = relationshipActivities
        .flatMap((activity) => relationshipFromActivity(activity) ?? [])
        .filter((edge) => includeReadEdges || edge.kind !== "readBy")
        .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
      const includedThreadIds = new Set<ThreadId>();
      const includedEdges: Array<ThreadOrchestrationRelationship> = [];

      if (input.rootThreadId === undefined) {
        for (const edge of allEdges.slice(0, edgeLimit)) {
          includedEdges.push(edge);
          includedThreadIds.add(edge.actorThreadId);
          includedThreadIds.add(edge.targetThreadId);
        }
      } else {
        includedThreadIds.add(input.rootThreadId);
        let frontier = new Set<ThreadId>([input.rootThreadId]);
        let depth = 0;
        while (frontier.size > 0 && depth < depthLimit && includedEdges.length < edgeLimit) {
          const nextFrontier = new Set<ThreadId>();
          for (const edge of allEdges) {
            if (!frontier.has(edge.actorThreadId) && !frontier.has(edge.targetThreadId)) {
              continue;
            }
            if (includedEdges.some((candidate) => candidate === edge)) {
              continue;
            }
            includedEdges.push(edge);
            includedThreadIds.add(edge.actorThreadId);
            includedThreadIds.add(edge.targetThreadId);
            nextFrontier.add(edge.actorThreadId);
            nextFrontier.add(edge.targetThreadId);
            if (includedEdges.length >= edgeLimit) {
              break;
            }
          }
          frontier = nextFrontier;
          depth += 1;
        }
      }

      return {
        nodes: [...includedThreadIds].flatMap((threadId) => summaries.get(threadId) ?? []),
        edges: includedEdges,
      };
    });

  const createThreadInternal = (
    scope: McpInvocationContext.McpInvocationScope | undefined,
    input: ThreadOrchestrationCreateThreadInput,
    options: {
      readonly modelSelectionIntent: "explicit" | "inherited";
      readonly batchId?: ThreadOrchestrationBatchId;
    },
  ) =>
    Effect.gen(function* () {
      const sourceThreadOption =
        scope === undefined
          ? Option.none<OrchestrationThreadShell>()
          : yield* snapshotQuery.getThreadShellById(scope.threadId).pipe(
              Effect.mapError(
                toThreadOrchestrationError("create_thread.source", {
                  threadId: scope.threadId,
                }),
              ),
            );
      const sourceThread = Option.getOrUndefined(sourceThreadOption);
      const resolvedInput = yield* resolveCreateInput(scope, sourceThread, input);
      const createCoordination = input.coordination;
      if (scope === undefined && createCoordination !== undefined) {
        return yield* new ThreadOrchestrationError({
          operation: "create_thread",
          code: "caller_required_for_coordination",
          message: "Root threads cannot join or inherit caller-owned coordination.",
        });
      }
      const currentCoordination =
        scope === undefined ||
        createCoordination?.effortId !== undefined ||
        createCoordination?.excludeInheritedEffort === true ||
        snapshotQuery.getThreadCoordinationShell === undefined
          ? undefined
          : yield* snapshotQuery
              .getThreadCoordinationShell()
              .pipe(Effect.mapError(toThreadOrchestrationError("create_thread.effort")));
      const inheritedEfforts =
        currentCoordination?.efforts.filter(
          (effort) => effort.coordinator.threadId === scope?.threadId && effort.closedAt === null,
        ) ?? [];
      if (inheritedEfforts.length > 1) {
        return yield* new ThreadOrchestrationError({
          operation: "create_thread",
          code: "ambiguous_effort",
          message:
            "This coordinator has more than one open effort. Choose one explicitly or disable effort inheritance.",
          ...(scope !== undefined ? { threadId: scope.threadId } : {}),
        });
      }
      const effortId =
        createCoordination?.effortId ??
        (createCoordination?.excludeInheritedEffort === true
          ? undefined
          : inheritedEfforts[0]?.effortId);
      if (options.modelSelectionIntent === "explicit") {
        yield* assertExplicitModelSelectionAllowed("create_thread", input.modelSelection);
      }
      yield* assertLegacyModelSelectionAllowed(
        "create_thread",
        resolvedInput.modelSelection,
        input.allowLegacyModel,
      );
      if (yield* shouldRouteRemote(input.target?.environmentId)) {
        if (scope === undefined) {
          return yield* remoteClient.createRootThread(resolvedInput);
        }
        const result = yield* remoteClient.createThread(scopeForRemote(scope), resolvedInput);
        const createdAt = yield* nowIso;
        yield* appendRelationship({
          scope,
          kind: "createdBy",
          targetThreadId: result.thread.threadId,
          targetEnvironmentId: result.thread.environmentId,
          recordOnThreadId: scope.threadId,
          ...(options.batchId !== undefined ? { batchId: options.batchId } : {}),
          ...(effortId !== undefined ? { effortId } : {}),
          ...(createCoordination?.label !== undefined ? { label: createCoordination.label } : {}),
          summary: `Created remote thread ${result.thread.threadId}.`,
          createdAt,
        });
        if (effortId !== undefined) {
          yield* addEffortMember(scope, {
            effortId,
            thread: {
              environmentId: result.thread.environmentId,
              threadId: result.thread.threadId,
            },
            label: createCoordination?.label ?? result.thread.title,
          });
        }
        return {
          ...result,
          ...(effortId === undefined
            ? {}
            : {
                membership: {
                  effortId,
                  thread: {
                    environmentId: result.thread.environmentId,
                    threadId: result.thread.threadId,
                  },
                  label: createCoordination?.label ?? result.thread.title,
                  joinedAt: createdAt,
                },
              }),
        };
      }
      if (scope !== undefined && !sourceThread && input.target?.projectId === undefined) {
        return yield* notFoundError("create_thread", "thread", scope.threadId, {
          threadId: scope.threadId,
        });
      }

      const projectId = input.target?.projectId ?? sourceThread?.projectId;
      if (projectId === undefined) {
        return yield* new ThreadOrchestrationError({
          operation: "create_thread",
          code: "project_required",
          message: "create_thread requires target.projectId when no caller thread supplies one.",
          ...(scope !== undefined ? { threadId: scope.threadId } : {}),
        });
      }
      const projectOption = yield* snapshotQuery
        .getProjectShellById(projectId)
        .pipe(Effect.mapError(toThreadOrchestrationError("create_thread.project", { projectId })));
      if (Option.isNone(projectOption)) {
        return yield* notFoundError("create_thread", "project", projectId, {
          projectId,
        });
      }
      const project = projectOption.value;

      const createdAt = yield* nowIso;
      const nextThreadId = yield* threadId("thread");
      const environment = input.target?.environment ?? ({ type: "local" } as const);
      const provisionalTitle = input.title ?? input.prompt.slice(0, 80);
      const naming =
        environment.type === "worktree" && input.title === undefined
          ? yield* generateBootstrapWorkspaceNaming({
              threadId: nextThreadId,
              cwd: project.workspaceRoot,
              message: input.prompt,
              provisionalTitle,
              textGeneration,
              serverSettings,
            })
          : undefined;
      const title = naming?.threadTitle ?? provisionalTitle;
      const prepared =
        environment.type === "worktree"
          ? yield* workspaceService
              .prepareWorkspace({
                threadId: nextThreadId,
                kind: "auto",
                roots: [
                  {
                    projectId: project.id,
                    sourcePath: project.workspaceRoot,
                    role: "primary",
                  },
                ],
                displayNameSeed: naming?.workspaceNameSeed ?? title,
                retentionPolicy: "explicit-delete",
              })
              .pipe(
                Effect.mapError(
                  toThreadOrchestrationError("create_thread.prepare_workspace", {
                    threadId: nextThreadId,
                    projectId: project.id,
                  }),
                ),
              )
          : undefined;

      const cleanupPreparedWorkspace =
        prepared === undefined
          ? Effect.void
          : workspaceService
              .deleteWorkspace({ workspaceId: prepared.workspace.id, force: true })
              .pipe(Effect.ignoreCause({ log: true }));

      yield* engine
        .dispatch({
          type: "thread.create",
          commandId: yield* commandId("thread-create"),
          threadId: nextThreadId,
          projectId: project.id,
          title,
          modelSelection: resolvedInput.modelSelection,
          runtimeMode: resolvedInput.runtimeMode,
          interactionMode: resolvedInput.interactionMode,
          ...(resolvedInput.skillPackIds !== undefined
            ? { skillPackIds: resolvedInput.skillPackIds }
            : {}),
          branch: prepared?.compatibilityBranch ?? null,
          worktreePath: prepared?.compatibilityWorktreePath ?? null,
          workspaceId: prepared?.workspace.id ?? null,
          createdAt,
        })
        .pipe(
          Effect.mapError(
            toThreadOrchestrationError("create_thread.dispatch", {
              threadId: nextThreadId,
              projectId: project.id,
            }),
          ),
          Effect.catch((error) =>
            cleanupPreparedWorkspace.pipe(Effect.flatMap(() => Effect.fail(error))),
          ),
        );

      yield* engine
        .dispatch({
          type: "thread.turn.start",
          commandId: yield* commandId("thread-create-turn-start"),
          threadId: nextThreadId,
          message: {
            messageId: yield* messageId("thread-create-message"),
            role: "user",
            text: input.prompt,
            attachments: [],
          },
          modelSelection: resolvedInput.modelSelection,
          runtimeMode: resolvedInput.runtimeMode,
          interactionMode: resolvedInput.interactionMode,
          createdAt,
        })
        .pipe(
          Effect.mapError(
            toThreadOrchestrationError("create_thread.turn_start", {
              threadId: nextThreadId,
              projectId: project.id,
            }),
          ),
        );

      if (scope !== undefined) {
        yield* appendRelationship({
          scope,
          kind: "createdBy",
          targetThreadId: nextThreadId,
          ...(options.batchId !== undefined ? { batchId: options.batchId } : {}),
          ...(effortId !== undefined ? { effortId } : {}),
          ...(createCoordination?.label !== undefined ? { label: createCoordination.label } : {}),
          wakeCoordinator: options.batchId === undefined && effortId === undefined,
          summary: `Created by thread ${scope.threadId}.`,
          createdAt,
        });
      }

      if (scope !== undefined && effortId !== undefined) {
        yield* addEffortMember(scope, {
          effortId,
          thread: { environmentId: yield* localEnvironmentId, threadId: nextThreadId },
          label: createCoordination?.label ?? title,
        });
      }
      if (scope !== undefined && createCoordination?.replaces !== undefined) {
        const replacementScope = { ...scope, threadId: nextThreadId };
        yield* appendRelationship({
          scope: replacementScope,
          kind: "replaces",
          targetThreadId: createCoordination.replaces.threadId,
          ...(createCoordination.replaces.environmentId === undefined
            ? {}
            : { targetEnvironmentId: createCoordination.replaces.environmentId }),
          recordOnThreadId: scope.threadId,
          ...(effortId !== undefined ? { effortId } : {}),
          summary: `Thread ${nextThreadId} replaces ${createCoordination.replaces.threadId}.`,
          createdAt,
        });
        if (effortId !== undefined) {
          yield* removeEffortMember(scope, {
            effortId,
            thread: createCoordination.replaces,
          });
        }
      }
      if (scope !== undefined && options.batchId === undefined && effortId === undefined) {
        yield* monitorDelegatedThread(scope, nextThreadId).pipe(
          Effect.ignoreCause({ log: true }),
          Effect.forkDetach,
        );
      }

      return {
        thread: {
          environmentId: yield* localEnvironmentId,
          threadId: nextThreadId,
          projectId: project.id,
          title,
          projectTitle: project.title,
          status: "running",
          modelSelection: resolvedInput.modelSelection,
          runtimeMode: resolvedInput.runtimeMode,
          interactionMode: resolvedInput.interactionMode,
          workspaceRoot: project.workspaceRoot,
          worktreePath: prepared?.compatibilityWorktreePath ?? null,
          outcome: "running" as const,
          backgroundLiveness: null,
          createdAt,
          updatedAt: createdAt,
        },
        promptSubmitted: true,
        ...(effortId === undefined
          ? {}
          : {
              membership: {
                effortId,
                thread: { environmentId: yield* localEnvironmentId, threadId: nextThreadId },
                label: createCoordination?.label ?? title,
                joinedAt: createdAt,
              },
            }),
      };
    });

  const createThread = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationCreateThreadInput,
  ) =>
    createThreadInternal(scope, input, {
      modelSelectionIntent: input.modelSelection === undefined ? "inherited" : "explicit",
    });

  const createRootThread = (input: ThreadOrchestrationCreateThreadInput) =>
    createThreadInternal(undefined, input, { modelSelectionIntent: "explicit" });

  const createThreadFromRemote = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationCreateThreadInput,
  ) =>
    createThreadInternal(scope, input, {
      modelSelectionIntent: input.modelSelection === undefined ? "inherited" : "explicit",
    });

  const resolveBatchDefinition = (
    scope: McpInvocationContext.McpInvocationScope,
    batchId: ThreadOrchestrationBatchId,
  ) =>
    Effect.gen(function* () {
      const globalBatchActivities = Object.hasOwn(
        snapshotQuery,
        "listThreadOrchestrationBatchActivities",
      )
        ? yield* snapshotQuery.listThreadOrchestrationBatchActivities!().pipe(
            Effect.mapError(toThreadOrchestrationError("read_batch.activities")),
          )
        : undefined;
      const definition = globalBatchActivities
        ?.map(batchDefinitionFromActivity)
        .find((candidate) => candidate?.batchId === batchId);
      if (globalBatchActivities !== undefined && definition == null) {
        return yield* new ThreadOrchestrationError({
          operation: "read_batch",
          code: "not_found",
          message: `Batch '${batchId}' was not found.`,
          resourceType: "batch",
          resourceId: batchId,
        });
      }
      const coordinatorThreadId = definition?.coordinatorThreadId ?? scope.threadId;
      const coordinatorOption = yield* snapshotQuery.getThreadDetailById(coordinatorThreadId).pipe(
        Effect.mapError(
          toThreadOrchestrationError("read_batch.coordinator", {
            threadId: coordinatorThreadId,
          }),
        ),
      );
      if (Option.isNone(coordinatorOption)) {
        return yield* notFoundError("read_batch", "thread", coordinatorThreadId, {
          threadId: coordinatorThreadId,
        });
      }
      const resolvedDefinition =
        definition ??
        coordinatorOption.value.activities
          .map(batchDefinitionFromActivity)
          .find((candidate) => candidate?.batchId === batchId);
      if (resolvedDefinition == null) {
        return yield* new ThreadOrchestrationError({
          operation: "read_batch",
          code: "not_found",
          message: `Batch '${batchId}' was not found on coordinator thread '${scope.threadId}'.`,
          threadId: scope.threadId,
          resourceType: "batch",
          resourceId: batchId,
        });
      }
      return { definition: resolvedDefinition, coordinator: coordinatorOption.value };
    });

  const readBatch = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationReadBatchInput,
  ) =>
    Effect.gen(function* () {
      const { definition, coordinator } = yield* resolveBatchDefinition(scope, input.batchId);
      const results = yield* Effect.forEach(
        definition.members,
        (member) =>
          readThreadResult(scope, {
            environmentId: member.environmentId,
            threadId: member.threadId,
          }).pipe(Effect.map((result) => ({ member, result }))),
        { concurrency: "unbounded" },
      );
      const members = results.map(({ member, result }) => ({
        label: member.label,
        workspaceIsolation: member.workspaceIsolation,
        outcome: result.thread.outcome ?? ("unknown" as const),
        thread: result.thread,
        latestAssistantMessage: result.latestAssistantMessage,
        queuedMessageCount: result.queuedMessageCount,
      }));
      const cancelled = hasBatchActivity(
        coordinator.activities,
        "thread-orchestration.batch.cancelled",
        input.batchId,
      );
      const settled = hasBatchActivity(
        coordinator.activities,
        "thread-orchestration.batch.settled",
        input.batchId,
      );
      const notified = hasBatchActivity(
        coordinator.activities,
        "thread-orchestration.batch.notified",
        input.batchId,
      );
      const currentTimeMillis = yield* Clock.currentTimeMillis;
      const deadlineExceeded =
        definition.deadlineAt !== null &&
        currentTimeMillis >= DateTime.toEpochMillis(DateTime.makeUnsafe(definition.deadlineAt));
      const outcomes = members.map((member) => member.outcome);
      const status = statusForBatch({
        cancelled: cancelled !== undefined,
        deadlineExceeded,
        outcomes,
      });
      return {
        batchId: definition.batchId,
        coordinatorEnvironmentId: definition.coordinatorEnvironmentId,
        coordinatorThreadId: definition.coordinatorThreadId,
        title: definition.title,
        prompt: definition.prompt,
        status,
        members,
        createdAt: definition.createdAt,
        deadlineAt: definition.deadlineAt,
        settledAt: settled?.createdAt ?? null,
        notifiedAt: notified?.createdAt ?? null,
      } satisfies ThreadOrchestrationBatch;
    });

  const interruptLocalBatchMembers = (batch: ThreadOrchestrationBatch) =>
    Effect.gen(function* () {
      const currentEnvironmentId = yield* localEnvironmentId;
      const createdDateTime = yield* DateTime.now;
      const createdAt = DateTime.formatIso(createdDateTime);
      yield* Effect.forEach(
        batch.members.filter(
          (member) =>
            member.thread.environmentId === currentEnvironmentId &&
            ["queued", "running", "blocked-approval", "blocked-input"].includes(member.outcome),
        ),
        (member) =>
          engine
            .dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.make(`${batch.batchId}:${member.thread.threadId}:interrupt`),
              threadId: member.thread.threadId,
              createdAt,
            })
            .pipe(
              Effect.mapError(
                toThreadOrchestrationError("cancel_batch.interrupt", {
                  threadId: member.thread.threadId,
                }),
              ),
            ),
        { concurrency: "unbounded", discard: true },
      );
    });

  const notifySettledBatch = (
    scope: McpInvocationContext.McpInvocationScope,
    batch: ThreadOrchestrationBatch,
  ) =>
    Effect.gen(function* () {
      if (batch.settledAt === null) {
        const settledAt = yield* nowIso;
        yield* appendBatchActivity({
          threadId: scope.threadId,
          batchId: batch.batchId,
          kind: "thread-orchestration.batch.settled",
          summary: `Batch ${batch.title} settled as ${batch.status}.`,
          payload: { status: batch.status },
          createdAt: settledAt,
        });
      }
      if (batch.notifiedAt !== null) return;
      const notifiedAt = yield* nowIso;
      const coordinatorOption = yield* snapshotQuery
        .getThreadShellById(scope.threadId)
        .pipe(
          Effect.mapError(
            toThreadOrchestrationError("batch.notify.coordinator", { threadId: scope.threadId }),
          ),
        );
      if (Option.isNone(coordinatorOption)) {
        return yield* notFoundError("batch.notify", "thread", scope.threadId, {
          threadId: scope.threadId,
        });
      }
      const resultLines = batch.members.map(
        (member) => `- ${member.label}: ${member.outcome} (${member.thread.threadId})`,
      );
      yield* engine
        .dispatch({
          type: "thread.message.queue",
          commandId: CommandId.make(`${batch.batchId}:notify:command`),
          threadId: scope.threadId,
          message: {
            messageId: MessageId.make(`${batch.batchId}:notify:message`),
            role: "user",
            text: [
              `Orchestration batch "${batch.title}" settled as ${batch.status}.`,
              ...resultLines,
              `Read the full results with: t3 thread batch read ${batch.batchId} --json`,
            ].join("\n"),
            attachments: [],
          },
          runtimeMode: coordinatorOption.value.runtimeMode,
          interactionMode: coordinatorOption.value.interactionMode,
          delivery: deliveryForCoordinatorNotification(
            batch.members.map((member) => member.outcome),
          ),
          createdAt: notifiedAt,
        })
        .pipe(
          Effect.mapError(toThreadOrchestrationError("batch.notify", { threadId: scope.threadId })),
        );
      yield* appendBatchActivity({
        threadId: batch.coordinatorThreadId,
        batchId: batch.batchId,
        kind: "thread-orchestration.batch.notified",
        summary: `Coordinator notified that batch ${batch.title} settled.`,
        createdAt: notifiedAt,
      });
    });

  const notifyBlockedBatch = (
    scope: McpInvocationContext.McpInvocationScope,
    batch: ThreadOrchestrationBatch,
  ) =>
    Effect.gen(function* () {
      const { coordinator } = yield* resolveBatchDefinition(scope, batch.batchId);
      if (
        hasBatchActivity(
          coordinator.activities,
          "thread-orchestration.batch.attention",
          batch.batchId,
        )
      ) {
        return;
      }
      const coordinatorOption = yield* snapshotQuery.getThreadShellById(scope.threadId).pipe(
        Effect.mapError(
          toThreadOrchestrationError("batch.attention.coordinator", {
            threadId: scope.threadId,
          }),
        ),
      );
      if (Option.isNone(coordinatorOption)) return;
      const blocked = batch.members.filter((member) =>
        ["blocked-approval", "blocked-input"].includes(member.outcome),
      );
      const createdAt = yield* nowIso;
      yield* engine
        .dispatch({
          type: "thread.message.queue",
          commandId: CommandId.make(`${batch.batchId}:attention:command`),
          threadId: scope.threadId,
          message: {
            messageId: MessageId.make(`${batch.batchId}:attention:message`),
            role: "user",
            text: [
              `Orchestration batch "${batch.title}" needs attention; its barrier remains open.`,
              ...blocked.map((member) => `- ${member.label}: ${member.outcome}`),
            ].join("\n"),
            attachments: [],
          },
          runtimeMode: coordinatorOption.value.runtimeMode,
          interactionMode: coordinatorOption.value.interactionMode,
          delivery: deliveryForCoordinatorNotification(blocked.map((member) => member.outcome)),
          createdAt,
        })
        .pipe(
          Effect.mapError(
            toThreadOrchestrationError("batch.attention", { threadId: scope.threadId }),
          ),
        );
      yield* appendBatchActivity({
        threadId: batch.coordinatorThreadId,
        batchId: batch.batchId,
        kind: "thread-orchestration.batch.attention",
        summary: `Batch ${batch.title} needs coordinator attention.`,
        createdAt,
      });
    });

  const monitorBatch = (
    scope: McpInvocationContext.McpInvocationScope,
    batchId: ThreadOrchestrationBatchId,
  ): Effect.Effect<void, ThreadOrchestrationError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const eventStream = Object.hasOwn(engine, "liveSubscriptionCapability")
          ? yield* engine.liveSubscriptionCapability!.subscribe
          : engine.streamDomainEvents;
        const batch = yield* readBatch(scope, { batchId });
        if (isTerminalBatchStatus(batch.status)) {
          if (batch.status === "deadline-exceeded") {
            yield* interruptLocalBatchMembers(batch);
          }
          return yield* notifySettledBatch(scope, batch);
        }
        if (batch.status === "blocked") {
          yield* notifyBlockedBatch(scope, batch);
        }
        const memberThreadIds = new Set(batch.members.map((member) => member.thread.threadId));
        const nextMemberEvent = eventStream.pipe(
          Stream.filter(
            (event) =>
              event.aggregateKind === "thread" &&
              memberThreadIds.has(ThreadId.make(event.aggregateId)),
          ),
          Stream.runHead,
          Effect.asVoid,
        );
        const deadlineSignal =
          batch.deadlineAt === null
            ? Effect.never
            : Effect.gen(function* () {
                const remaining =
                  DateTime.toEpochMillis(DateTime.makeUnsafe(batch.deadlineAt!)) -
                  (yield* Clock.currentTimeMillis);
                if (remaining > 0) yield* Effect.sleep(Duration.millis(remaining));
              });
        yield* Effect.raceFirst(nextMemberEvent, deadlineSignal);
        return yield* monitorBatch(scope, batchId);
      }),
    );

  const createBatch = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationCreateBatchInput,
  ) =>
    Effect.gen(function* () {
      const batchId = yield* makeId(
        crypto,
        "thread-orchestration:batch",
        ThreadOrchestrationBatchId.make,
      );
      const createdDateTime = yield* DateTime.now;
      const createdAt = DateTime.formatIso(createdDateTime);
      const timeoutMs =
        input.timeoutMs === undefined ? undefined : Math.min(input.timeoutMs, MAX_BATCH_TIMEOUT_MS);
      const deadlineAt =
        timeoutMs === undefined
          ? null
          : DateTime.formatIso(DateTime.add(createdDateTime, { milliseconds: timeoutMs }));
      const created = yield* Effect.forEach(
        input.workers,
        (worker) =>
          createThreadInternal(
            scope,
            {
              prompt: worker.prompt ?? input.prompt,
              ...(worker.target !== undefined ? { target: worker.target } : {}),
              ...(worker.modelSelection !== undefined
                ? { modelSelection: worker.modelSelection }
                : {}),
              ...(input.allowLegacyModel === true ? { allowLegacyModel: true } : {}),
              ...(worker.runtimeMode !== undefined ? { runtimeMode: worker.runtimeMode } : {}),
              ...(worker.interactionMode !== undefined
                ? { interactionMode: worker.interactionMode }
                : {}),
              title: worker.title ?? worker.label,
            },
            {
              modelSelectionIntent: worker.modelSelection === undefined ? "inherited" : "explicit",
              batchId,
            },
          ).pipe(
            Effect.map((result) => ({
              label: worker.label,
              workspaceIsolation:
                worker.target?.environment?.type === "worktree"
                  ? ("worktree" as const)
                  : ("shared" as const),
              result,
            })),
          ),
        { concurrency: "unbounded" },
      );
      const coordinatorEnvironmentId = yield* localEnvironmentId;
      const definition: StoredBatchDefinition = {
        batchId,
        coordinatorEnvironmentId,
        coordinatorThreadId: scope.threadId,
        title: input.title ?? `${input.workers.length} worker effort`,
        prompt: input.prompt,
        members: created.map(({ label, workspaceIsolation, result }) => ({
          label,
          environmentId: result.thread.environmentId,
          threadId: result.thread.threadId,
          workspaceIsolation,
        })),
        createdAt,
        deadlineAt,
      };
      yield* appendBatchActivity({
        threadId: scope.threadId,
        batchId,
        kind: "thread-orchestration.batch.created",
        summary: `Started ${definition.title} with ${definition.members.length} workers.`,
        payload: definition,
        createdAt,
      });
      yield* monitorBatch(scope, batchId).pipe(
        Effect.ignoreCause({ log: true }),
        Effect.forkDetach,
      );
      return { batch: yield* readBatch(scope, { batchId }) };
    });

  const cancelBatch = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationCancelBatchInput,
  ) =>
    Effect.gen(function* () {
      const batch = yield* readBatch(scope, input);
      const currentEnvironmentId = yield* localEnvironmentId;
      const remoteMembers = batch.members.filter(
        (member) => member.thread.environmentId !== currentEnvironmentId,
      );
      if (remoteMembers.length > 0) {
        return yield* new ThreadOrchestrationError({
          operation: "cancel_batch",
          code: "cross_host_operation_unsupported",
          message: `Batch '${input.batchId}' has ${remoteMembers.length} remote member(s). Cross-host cancellation is not available yet; no workers were interrupted.`,
          threadId: batch.coordinatorThreadId,
          resourceType: "batch",
          resourceId: input.batchId,
        });
      }
      yield* interruptLocalBatchMembers(batch);
      const cancelledAt = yield* nowIso;
      yield* appendBatchActivity({
        threadId: batch.coordinatorThreadId,
        batchId: input.batchId,
        kind: "thread-orchestration.batch.cancelled",
        summary: `Cancelled batch ${batch.title}.`,
        createdAt: cancelledAt,
      });
      return yield* readBatch(scope, input);
    });

  const cleanupBatch = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationCleanupBatchInput,
  ) =>
    Effect.gen(function* () {
      const batch = yield* readBatch(scope, input);
      if (!batch.members.every((member) => isTerminalBatchMemberOutcome(member.outcome))) {
        return yield* new ThreadOrchestrationError({
          operation: "cleanup_batch",
          code: "batch_members_active",
          message: `Batch '${input.batchId}' still has queued, running, or blocked members. Cancel and wait for every worker to stop before cleanup.`,
          threadId: batch.coordinatorThreadId,
          resourceType: "batch",
          resourceId: input.batchId,
        });
      }
      const currentEnvironmentId = yield* localEnvironmentId;
      if (batch.members.some((member) => member.thread.environmentId !== currentEnvironmentId)) {
        return yield* new ThreadOrchestrationError({
          operation: "cleanup_batch",
          code: "cross_host_operation_unsupported",
          message: `Batch '${input.batchId}' has remote members. Cross-host cleanup is not available yet; no workspaces were deleted.`,
          threadId: batch.coordinatorThreadId,
          resourceType: "batch",
          resourceId: input.batchId,
        });
      }
      const workspaceIds = yield* Effect.forEach(
        batch.members.filter((member) => member.thread.environmentId === currentEnvironmentId),
        (member) => snapshotQuery.getThreadShellById(member.thread.threadId),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(toThreadOrchestrationError("cleanup_batch.resolve_workspaces")),
        Effect.map((threads) =>
          threads.flatMap((thread) => {
            const workspaceId = Option.isSome(thread) ? thread.value.workspaceId : undefined;
            return workspaceId == null ? [] : [workspaceId];
          }),
        ),
      );
      yield* Effect.forEach(
        workspaceIds,
        (workspaceId) => workspaceService.deleteWorkspace({ workspaceId, force: true }),
        { concurrency: 2, discard: true },
      ).pipe(Effect.mapError(toThreadOrchestrationError("cleanup_batch.delete_workspaces")));
      const cleanedAt = yield* nowIso;
      yield* appendBatchActivity({
        threadId: batch.coordinatorThreadId,
        batchId: input.batchId,
        kind: "thread-orchestration.batch.cleaned",
        summary: `Cleaned ${workspaceIds.length} managed batch workspaces.`,
        payload: { deletedWorkspaceCount: workspaceIds.length },
        createdAt: cleanedAt,
      });
      return { batch: yield* readBatch(scope, input), deletedWorkspaceCount: workspaceIds.length };
    });

  const coordinationShell = () =>
    snapshotQuery.getThreadCoordinationShell === undefined
      ? Effect.succeed({ relationships: [], efforts: [], waits: [], watches: [] })
      : snapshotQuery
          .getThreadCoordinationShell()
          .pipe(Effect.mapError(toThreadOrchestrationError("coordination.read")));

  const assertCoordinator = (
    operation: string,
    scope: McpInvocationContext.McpInvocationScope,
    coordinator: OrchestrationThreadRef,
    resourceType: "effort" | "wait" | "watch",
    resourceId: string,
  ) =>
    Effect.gen(function* () {
      const currentEnvironmentId = yield* localEnvironmentId;
      if (
        coordinator.threadId === scope.threadId &&
        (coordinator.environmentId === undefined ||
          coordinator.environmentId === currentEnvironmentId)
      ) {
        return;
      }
      return yield* new ThreadOrchestrationError({
        operation,
        code: "not_coordinator",
        message: `Only coordinator thread '${coordinator.threadId}' may change ${resourceType} '${resourceId}'.`,
        threadId: scope.threadId,
        resourceType,
        resourceId,
      });
    });

  const readEffort = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationReadEffortInput,
  ) =>
    Effect.gen(function* () {
      const coordination = yield* coordinationShell();
      const effort = coordination.efforts.find(
        (candidate) => candidate.effortId === input.effortId,
      );
      if (effort === undefined) {
        return yield* new ThreadOrchestrationError({
          operation: "read_effort",
          code: "not_found",
          message: `Effort '${input.effortId}' was not found.`,
          threadId: scope.threadId,
          resourceType: "effort",
          resourceId: input.effortId,
        });
      }
      return effort;
    });

  const listEfforts = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationListEffortsInput,
  ) =>
    Effect.gen(function* () {
      const coordination = yield* coordinationShell();
      const currentEnvironmentId = yield* localEnvironmentId;
      return {
        efforts: coordination.efforts.filter(
          (effort) =>
            effort.coordinator.threadId === scope.threadId &&
            (effort.coordinator.environmentId === undefined ||
              effort.coordinator.environmentId === currentEnvironmentId) &&
            (input.includeClosed === true || effort.closedAt === null),
        ),
      } satisfies ThreadOrchestrationListEffortsResult;
    });

  const createEffort = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationCreateEffortInput,
  ) =>
    Effect.gen(function* () {
      const effortId = yield* makeId(
        crypto,
        "thread-orchestration:effort",
        ThreadOrchestrationEffortId.make,
      );
      const openedAt = yield* nowIso;
      const effort: OrchestrationEffortShell = {
        effortId,
        coordinator: { environmentId: yield* localEnvironmentId, threadId: scope.threadId },
        title: input.title,
        members: [],
        openedAt,
        closedAt: null,
      };
      yield* appendCoordinationActivity({
        threadId: scope.threadId,
        kind: "thread-orchestration.effort.opened",
        summary: `Opened effort ${input.title}.`,
        payload: { kind: "opened", effort },
        createdAt: openedAt,
        stableId: `${effortId}:opened`,
      });
      return effort;
    });

  const renameEffort = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationRenameEffortInput,
  ) =>
    Effect.gen(function* () {
      const effort = yield* readEffort(scope, input);
      yield* assertCoordinator(
        "rename_effort",
        scope,
        effort.coordinator,
        "effort",
        input.effortId,
      );
      const changedAt = yield* nowIso;
      yield* appendCoordinationActivity({
        threadId: scope.threadId,
        kind: "thread-orchestration.effort.renamed",
        summary: `Renamed effort to ${input.title}.`,
        payload: { kind: "renamed", effortId: input.effortId, title: input.title, changedAt },
        createdAt: changedAt,
      });
      return { ...effort, title: input.title };
    });

  const stopThread = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationStopThreadInput,
  ) =>
    Effect.gen(function* () {
      if (yield* shouldRouteRemote(input.environmentId)) {
        return yield* new ThreadOrchestrationError({
          operation: "stop_thread",
          code: "cross_host_operation_unsupported",
          message: "Cross-host thread stopping is not available yet.",
          threadId: input.threadId,
          environmentId: input.environmentId,
          resourceType: "thread",
          resourceId: input.threadId,
        });
      }
      const current = yield* readThreadResult(scope, { threadId: input.threadId });
      if (isTerminalBatchMemberOutcome(current.thread.outcome ?? "unknown")) {
        return current.thread;
      }
      const createdAt = yield* nowIso;
      yield* engine
        .dispatch({
          type: "thread.turn.interrupt",
          commandId: yield* commandId("thread-stop"),
          threadId: input.threadId,
          createdAt,
        })
        .pipe(
          Effect.mapError(toThreadOrchestrationError("stop_thread", { threadId: input.threadId })),
        );
      return yield* resolveThreadSummary(input.threadId);
    });

  const closeEffort = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationCloseEffortInput,
  ) =>
    Effect.gen(function* () {
      const effort = yield* readEffort(scope, input);
      yield* assertCoordinator("close_effort", scope, effort.coordinator, "effort", input.effortId);
      if (input.stopMembers === true) {
        const currentEnvironmentId = yield* localEnvironmentId;
        if (
          effort.members.some(
            (member) =>
              member.thread.environmentId !== undefined &&
              member.thread.environmentId !== currentEnvironmentId,
          )
        ) {
          return yield* new ThreadOrchestrationError({
            operation: "close_effort",
            code: "cross_host_operation_unsupported",
            message:
              "This effort has remote members. Cross-host stopping is not available yet; no members were interrupted.",
            threadId: scope.threadId,
            resourceType: "effort",
            resourceId: input.effortId,
          });
        }
        yield* Effect.forEach(
          effort.members,
          (member) =>
            stopThread(scope, {
              ...(member.thread.environmentId === undefined
                ? {}
                : { environmentId: member.thread.environmentId }),
              threadId: member.thread.threadId,
            }),
          { concurrency: "unbounded", discard: true },
        );
      }
      const closedAt = yield* nowIso;
      yield* appendCoordinationActivity({
        threadId: scope.threadId,
        kind: "thread-orchestration.effort.closed",
        summary: `Closed effort ${effort.title}.`,
        payload: { kind: "closed", effortId: input.effortId, closedAt },
        createdAt: closedAt,
      });
      return { ...effort, closedAt };
    });

  const reopenEffort = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationReopenEffortInput,
  ) =>
    Effect.gen(function* () {
      const effort = yield* readEffort(scope, input);
      yield* assertCoordinator(
        "reopen_effort",
        scope,
        effort.coordinator,
        "effort",
        input.effortId,
      );
      const reopenedAt = yield* nowIso;
      yield* appendCoordinationActivity({
        threadId: scope.threadId,
        kind: "thread-orchestration.effort.reopened",
        summary: `Reopened effort ${effort.title}.`,
        payload: { kind: "reopened", effortId: input.effortId, reopenedAt },
        createdAt: reopenedAt,
      });
      return { ...effort, closedAt: null };
    });

  const addEffortMember = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationAddEffortMemberInput,
  ) =>
    Effect.gen(function* () {
      const effort = yield* readEffort(scope, input);
      yield* assertCoordinator(
        "add_effort_member",
        scope,
        effort.coordinator,
        "effort",
        input.effortId,
      );
      if (effort.closedAt !== null) {
        return yield* new ThreadOrchestrationError({
          operation: "add_effort_member",
          code: "effort_closed",
          message: `Effort '${input.effortId}' is closed.`,
          threadId: scope.threadId,
          resourceType: "effort",
          resourceId: input.effortId,
        });
      }
      yield* readThreadResult(scope, {
        ...(input.thread.environmentId === undefined
          ? {}
          : { environmentId: input.thread.environmentId }),
        threadId: input.thread.threadId,
      });
      const joinedAt = yield* nowIso;
      const member = {
        thread: {
          environmentId: input.thread.environmentId ?? (yield* localEnvironmentId),
          threadId: input.thread.threadId,
        },
        label: input.label,
        joinedAt,
      };
      yield* appendCoordinationActivity({
        threadId: scope.threadId,
        kind: "thread-orchestration.effort.member-joined",
        summary: `Added ${input.label} to effort ${effort.title}.`,
        payload: { kind: "member-joined", effortId: input.effortId, member },
        createdAt: joinedAt,
      });
      return {
        ...effort,
        members: [
          ...effort.members.filter(
            (candidate) =>
              candidate.thread.environmentId !== member.thread.environmentId ||
              candidate.thread.threadId !== member.thread.threadId,
          ),
          member,
        ],
      };
    });

  const removeEffortMember = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationRemoveEffortMemberInput,
  ) =>
    Effect.gen(function* () {
      const effort = yield* readEffort(scope, input);
      yield* assertCoordinator(
        "remove_effort_member",
        scope,
        effort.coordinator,
        "effort",
        input.effortId,
      );
      const environmentId = input.thread.environmentId ?? (yield* localEnvironmentId);
      const changedAt = yield* nowIso;
      const thread = { environmentId, threadId: input.thread.threadId };
      yield* appendCoordinationActivity({
        threadId: scope.threadId,
        kind: "thread-orchestration.effort.member-left",
        summary: `Removed thread ${input.thread.threadId} from effort ${effort.title}.`,
        payload: { kind: "member-left", effortId: input.effortId, thread, changedAt },
        createdAt: changedAt,
      });
      return {
        ...effort,
        members: effort.members.filter(
          (member) =>
            member.thread.environmentId !== environmentId ||
            member.thread.threadId !== input.thread.threadId,
        ),
      };
    });

  const refreshWait = (
    scope: McpInvocationContext.McpInvocationScope,
    wait: OrchestrationWaitShell,
  ) =>
    Effect.gen(function* () {
      const members = yield* Effect.forEach(
        wait.members,
        (member) =>
          readThreadResult(scope, {
            ...(member.thread.environmentId === undefined
              ? {}
              : { environmentId: member.thread.environmentId }),
            threadId: member.thread.threadId,
          }).pipe(
            Effect.map((result) => ({
              thread: member.thread,
              outcome: result.thread.outcome ?? ("unknown" as const),
            })),
          ),
        { concurrency: "unbounded" },
      );
      return { ...wait, members } satisfies OrchestrationWaitShell;
    });

  const readWait = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationReadWaitInput,
  ) =>
    Effect.gen(function* () {
      const coordination = yield* coordinationShell();
      const wait = coordination.waits.find((candidate) => candidate.waitId === input.waitId);
      if (wait === undefined) {
        return yield* new ThreadOrchestrationError({
          operation: "read_wait",
          code: "not_found",
          message: `Wait '${input.waitId}' was not found.`,
          threadId: scope.threadId,
          resourceType: "wait",
          resourceId: input.waitId,
        });
      }
      return yield* refreshWait(scope, wait);
    });

  const listWaits = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationListWaitsInput,
  ) =>
    Effect.gen(function* () {
      const coordination = yield* coordinationShell();
      const currentEnvironmentId = yield* localEnvironmentId;
      const waits = yield* Effect.forEach(
        coordination.waits.filter(
          (wait) =>
            wait.coordinator.threadId === scope.threadId &&
            (wait.coordinator.environmentId === undefined ||
              wait.coordinator.environmentId === currentEnvironmentId) &&
            (input.effortId === undefined || wait.effortId === input.effortId) &&
            (input.includeResolved === true || wait.state === "open"),
        ),
        (wait) => refreshWait(scope, wait),
        { concurrency: "unbounded" },
      );
      return { waits } satisfies ThreadOrchestrationListWaitsResult;
    });

  const notifyWait = (
    scope: McpInvocationContext.McpInvocationScope,
    wait: OrchestrationWaitShell,
    kind: "attention" | "resolved",
  ) =>
    Effect.gen(function* () {
      const coordinator = yield* snapshotQuery
        .getThreadShellById(scope.threadId)
        .pipe(
          Effect.mapError(toThreadOrchestrationError("wait.notify", { threadId: scope.threadId })),
        );
      if (Option.isNone(coordinator)) return;
      const relevant =
        kind === "attention"
          ? wait.members.filter((member) =>
              ["blocked-approval", "blocked-input"].includes(member.outcome ?? "unknown"),
            )
          : wait.members;
      const createdAt = yield* nowIso;
      const notificationPolicy = wait.notificationPolicy;
      const generatedSummary =
        kind === "resolved" && notificationPolicy?.type === "summarize"
          ? yield* Effect.gen(function* () {
              const settings = yield* serverSettings.getSettings;
              const results = yield* Effect.forEach(
                relevant,
                (member) =>
                  readThreadResult(scope, {
                    ...(member.thread.environmentId === undefined
                      ? {}
                      : { environmentId: member.thread.environmentId }),
                    threadId: member.thread.threadId,
                  }),
                { concurrency: "unbounded" },
              );
              const generated = yield* textGeneration.generateNotification({
                cwd:
                  coordinator.value.worktreePath ??
                  (yield* snapshotQuery.getProjectShellById(coordinator.value.projectId).pipe(
                    Effect.flatMap(
                      Option.match({
                        onNone: () => Effect.succeed(process.cwd()),
                        onSome: (project) => Effect.succeed(project.workspaceRoot),
                      }),
                    ),
                    Effect.mapError(
                      toThreadOrchestrationError("wait.notify.project", {
                        threadId: scope.threadId,
                      }),
                    ),
                  )),
                kind: "waitSummary",
                modelSelection: settings.textGenerationModelSelection,
                prompt: [
                  "Summarize a settled orchestration wait for its coordinator.",
                  "Identify failures and meaningful disagreements. Recommend one concrete next step.",
                  "Do not use tools and do not change whether the wait is settled.",
                  ...(notificationPolicy.instruction
                    ? [`Additional instruction: ${notificationPolicy.instruction}`]
                    : []),
                  `Wait state: ${wait.state}`,
                  ...results.map(
                    (result) =>
                      `${result.thread.threadId} (${result.thread.outcome ?? "unknown"}): ${result.latestAssistantMessage?.text ?? "No assistant result."}`,
                  ),
                ].join("\n"),
              });
              return generated.kind === "waitSummary" ? generated.result : null;
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("wait summary generation failed; using raw results", {
                  waitId: wait.waitId,
                  cause,
                }).pipe(Effect.as(null)),
              ),
            )
          : null;
      const notificationKey =
        kind === "attention"
          ? relevant
              .map(
                (member) =>
                  `${member.thread.environmentId ?? "local"}:${member.thread.threadId}:${member.outcome ?? "unknown"}`,
              )
              .toSorted()
              .join(",")
          : wait.state;
      yield* engine
        .dispatch({
          type: "thread.message.queue",
          commandId: CommandId.make(`${wait.waitId}:${kind}:${notificationKey}:message-command`),
          threadId: scope.threadId,
          message: {
            messageId: MessageId.make(`${wait.waitId}:${kind}:${notificationKey}:message`),
            role: "user",
            text: [
              kind === "attention"
                ? `Orchestration wait ${wait.waitId} needs attention.`
                : `Orchestration wait ${wait.waitId} resolved as ${wait.state}.`,
              ...relevant.map(
                (member) => `- ${member.thread.threadId}: ${member.outcome ?? "unknown"}`,
              ),
              ...(generatedSummary === null
                ? []
                : [
                    `Summary: ${generatedSummary.summary}`,
                    ...generatedSummary.failures.map((failure) => `Failure: ${failure}`),
                    ...generatedSummary.disagreements.map(
                      (disagreement) => `Disagreement: ${disagreement}`,
                    ),
                    `Recommended next step: ${generatedSummary.recommendedNextStep}`,
                  ]),
              `Inspect it with: t3 thread wait read ${wait.waitId} --json`,
            ].join("\n"),
            attachments: [],
            origin: {
              type: "wait",
              waitId: wait.waitId,
              state:
                kind === "attention"
                  ? "attention"
                  : wait.state === "deadline-exceeded"
                    ? "deadline-exceeded"
                    : "satisfied",
              ...(generatedSummary?.summary.trim()
                ? { summary: generatedSummary.summary.trim() }
                : {}),
            },
          },
          runtimeMode: coordinator.value.runtimeMode,
          interactionMode: coordinator.value.interactionMode,
          delivery: deliveryForCoordinatorNotification(
            relevant.map((member) => member.outcome),
            "wait",
          ),
          createdAt,
        })
        .pipe(
          Effect.mapError(toThreadOrchestrationError("wait.notify", { threadId: scope.threadId })),
        );
    });

  const waitIsSatisfied = (wait: OrchestrationWaitShell) => {
    const terminal = wait.members.filter((member) =>
      isTerminalBatchMemberOutcome(member.outcome ?? "unknown"),
    ).length;
    return wait.mode === "all" ? terminal === wait.members.length : terminal > 0;
  };

  const monitorWait = (
    scope: McpInvocationContext.McpInvocationScope,
    waitId: ThreadOrchestrationWaitId,
  ): Effect.Effect<void, ThreadOrchestrationError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const eventStream = Object.hasOwn(engine, "liveSubscriptionCapability")
          ? yield* engine.liveSubscriptionCapability!.subscribe
          : engine.streamDomainEvents;
        const wait = yield* readWait(scope, { waitId });
        if (wait.state !== "open") return;
        const now = yield* Clock.currentTimeMillis;
        const deadlineExceeded =
          wait.deadlineAt !== null &&
          now >= DateTime.toEpochMillis(DateTime.makeUnsafe(wait.deadlineAt));
        if (deadlineExceeded || waitIsSatisfied(wait)) {
          const resolvedAt = yield* nowIso;
          const state = deadlineExceeded ? ("deadline-exceeded" as const) : ("satisfied" as const);
          const resolved = { ...wait, state, resolvedAt };
          yield* appendCoordinationActivity({
            threadId: scope.threadId,
            kind: "thread-orchestration.wait.resolved",
            summary: `Wait resolved as ${state}.`,
            payload: { kind: "resolved", waitId, state, members: wait.members, resolvedAt },
            createdAt: resolvedAt,
            stableId: `${waitId}:resolved`,
          });
          return yield* notifyWait(scope, resolved, "resolved");
        }
        for (const member of wait.members.filter((candidate) =>
          ["blocked-approval", "blocked-input"].includes(candidate.outcome ?? "unknown"),
        )) {
          const changedAt = yield* nowIso;
          yield* appendCoordinationActivity({
            threadId: scope.threadId,
            kind: "thread-orchestration.wait.attention",
            summary: `Wait member ${member.thread.threadId} needs attention.`,
            payload: { kind: "attention", waitId, member, changedAt },
            createdAt: changedAt,
            stableId: `${waitId}:attention:${member.thread.threadId}:${member.outcome}`,
          });
        }
        if (
          wait.members.some((member) =>
            ["blocked-approval", "blocked-input"].includes(member.outcome ?? "unknown"),
          )
        ) {
          yield* notifyWait(scope, wait, "attention");
        }
        const memberThreadIds = new Set(wait.members.map((member) => member.thread.threadId));
        const nextMemberEvent = eventStream.pipe(
          Stream.filter(
            (event) =>
              event.aggregateKind === "thread" &&
              memberThreadIds.has(ThreadId.make(event.aggregateId)),
          ),
          Stream.runHead,
          Effect.asVoid,
        );
        const deadlineSignal =
          wait.deadlineAt === null
            ? Effect.never
            : Effect.sleep(
                Duration.millis(
                  Math.max(0, DateTime.toEpochMillis(DateTime.makeUnsafe(wait.deadlineAt)) - now),
                ),
              );
        yield* Effect.raceFirst(nextMemberEvent, deadlineSignal);
        return yield* monitorWait(scope, waitId);
      }),
    );

  const createWait = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationCreateWaitInput,
  ) =>
    Effect.gen(function* () {
      if ((input.effortId === undefined) === (input.members === undefined)) {
        return yield* new ThreadOrchestrationError({
          operation: "create_wait",
          code: "invalid_member_source",
          message: "Create a wait from exactly one source: effortId or members.",
          threadId: scope.threadId,
        });
      }
      const effort =
        input.effortId === undefined
          ? undefined
          : yield* readEffort(scope, { effortId: input.effortId });
      if (effort !== undefined) {
        yield* assertCoordinator(
          "create_wait",
          scope,
          effort.coordinator,
          "effort",
          effort.effortId,
        );
      }
      const currentEnvironmentId = yield* localEnvironmentId;
      const refs = (effort?.members.map((member) => member.thread) ?? input.members ?? []).map(
        (member) => ({
          environmentId: member.environmentId ?? currentEnvironmentId,
          threadId: member.threadId,
        }),
      );
      if (refs.length === 0) {
        return yield* new ThreadOrchestrationError({
          operation: "create_wait",
          code: "members_required",
          message: "A wait requires at least one member thread.",
          threadId: scope.threadId,
        });
      }
      if (refs.some((member) => member.environmentId !== currentEnvironmentId)) {
        return yield* new ThreadOrchestrationError({
          operation: "create_wait",
          code: "cross_host_operation_unsupported",
          message:
            "Cross-host waits are not available yet. Create the wait on one environment or monitor remote members explicitly.",
          threadId: scope.threadId,
        });
      }
      const waitId = yield* makeId(
        crypto,
        "thread-orchestration:wait",
        ThreadOrchestrationWaitId.make,
      );
      const openedDateTime = yield* DateTime.now;
      const openedAt = DateTime.formatIso(openedDateTime);
      const deadlineMs =
        input.deadlineMs === undefined
          ? undefined
          : Math.min(input.deadlineMs, MAX_BATCH_TIMEOUT_MS);
      const wait: OrchestrationWaitShell = {
        waitId,
        coordinator: { environmentId: currentEnvironmentId, threadId: scope.threadId },
        ...(input.effortId === undefined ? {} : { effortId: input.effortId }),
        members: refs.map((thread) => ({ thread, outcome: "unknown" as const })),
        mode: input.mode ?? "all",
        state: "open",
        openedAt,
        deadlineAt:
          deadlineMs === undefined
            ? null
            : DateTime.formatIso(DateTime.add(openedDateTime, { milliseconds: deadlineMs })),
        resolvedAt: null,
        notificationPolicy: input.notificationPolicy ?? { type: "raw" },
      };
      yield* appendCoordinationActivity({
        threadId: scope.threadId,
        kind: "thread-orchestration.wait.opened",
        summary: `Waiting for ${refs.length} thread${refs.length === 1 ? "" : "s"}.`,
        payload: { kind: "opened", wait },
        createdAt: openedAt,
        stableId: `${waitId}:opened`,
      });
      yield* monitorWait(scope, waitId).pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);
      return wait;
    });

  const cancelWait = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationCancelWaitInput,
  ) =>
    Effect.gen(function* () {
      const wait = yield* readWait(scope, input);
      yield* assertCoordinator("cancel_wait", scope, wait.coordinator, "wait", input.waitId);
      if (wait.state !== "open") return wait;
      const resolvedAt = yield* nowIso;
      yield* appendCoordinationActivity({
        threadId: scope.threadId,
        kind: "thread-orchestration.wait.resolved",
        summary: "Cancelled wait.",
        payload: {
          kind: "resolved",
          waitId: input.waitId,
          state: "cancelled",
          members: wait.members,
          resolvedAt,
        },
        createdAt: resolvedAt,
        stableId: `${input.waitId}:resolved`,
      });
      return { ...wait, state: "cancelled" as const, resolvedAt };
    });

  const readWatch = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationReadWatchInput,
  ) =>
    Effect.gen(function* () {
      const coordination = yield* coordinationShell();
      const watch = coordination.watches.find((candidate) => candidate.watchId === input.watchId);
      if (watch === undefined) {
        return yield* new ThreadOrchestrationError({
          operation: "read_watch",
          code: "not_found",
          message: `Watch '${input.watchId}' was not found.`,
          threadId: scope.threadId,
          resourceType: "watch",
          resourceId: input.watchId,
        });
      }
      return watch;
    });

  const listWatches = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationListWatchesInput,
  ) =>
    Effect.gen(function* () {
      const coordination = yield* coordinationShell();
      const currentEnvironmentId = yield* localEnvironmentId;
      return {
        watches: coordination.watches.filter(
          (watch) =>
            watch.coordinator.threadId === scope.threadId &&
            (watch.coordinator.environmentId === undefined ||
              watch.coordinator.environmentId === currentEnvironmentId) &&
            (input.includeClosed === true || watch.state === "open"),
        ),
      } satisfies ThreadOrchestrationListWatchesResult;
    });

  const closeWatchInternal = (
    _scope: McpInvocationContext.McpInvocationScope,
    watch: OrchestrationWatchShell,
    state: "completed" | "cancelled" | "failed",
    reason: string,
    interrupt: boolean,
  ) =>
    Effect.gen(function* () {
      if (watch.state !== "open") return watch;
      const closedAt = yield* nowIso;
      yield* appendCoordinationActivity({
        threadId: watch.coordinator.threadId,
        kind: "thread-orchestration.watch.closed",
        summary: `Watch ${state}: ${reason}`,
        payload: {
          kind: "closed",
          watchId: watch.watchId,
          generation: watch.generation,
          state,
          reason,
          closedAt,
        },
        createdAt: closedAt,
        stableId: `${watch.watchId}:closed`,
      });
      if (interrupt) {
        const fiber = watchFibers.get(watch.watchId);
        if (fiber !== undefined) yield* Fiber.interrupt(fiber);
      }
      return { ...watch, state, closedAt };
    });

  const decideWatchBatch = (
    watch: OrchestrationWatchShell,
    cwd: string,
    events: [string, ...string[]],
  ) =>
    Effect.gen(function* () {
      const rawSummary = events.join("\n");
      if (watch.policy.type === "always") {
        return { action: "wake" as const, summary: rawSummary };
      }
      const settings = yield* serverSettings.getSettings;
      const generated = yield* textGeneration.generateNotification({
        cwd,
        kind: "watchDecision",
        modelSelection: settings.textGenerationModelSelection,
        prompt: [
          "Decide whether a durable monitor event should wake its coding agent.",
          "Return ignore when the event does not satisfy the instruction, wake when it does,",
          "or close when it satisfies the instruction and further monitoring is unnecessary.",
          "Do not use tools. Keep summary factual and concise.",
          `Instruction: ${watch.policy.instruction}`,
          "Events:",
          rawSummary,
        ].join("\n"),
      });
      return generated.kind === "watchDecision"
        ? generated.result
        : { action: "wake" as const, summary: rawSummary };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("watch policy generation failed; waking with raw events", {
          watchId: watch.watchId,
          cause,
        }).pipe(Effect.as({ action: "wake" as const, summary: events.join("\n") })),
      ),
    );

  const notifyWatch = (
    watch: OrchestrationWatchShell,
    generation: number,
    sequence: number,
    events: [string, ...string[]],
    decision: "wake" | "close",
    summary: string,
  ) =>
    Effect.gen(function* () {
      const coordinator = yield* snapshotQuery
        .getThreadShellById(watch.coordinator.threadId)
        .pipe(
          Effect.mapError(
            toThreadOrchestrationError("watch.notify", { threadId: watch.coordinator.threadId }),
          ),
        );
      if (Option.isNone(coordinator)) return;
      const createdAt = yield* nowIso;
      yield* engine.dispatch({
        type: "thread.message.queue",
        commandId: CommandId.make(`${watch.watchId}:${generation}:${sequence}:message-command`),
        threadId: watch.coordinator.threadId,
        message: {
          messageId: MessageId.make(`${watch.watchId}:${generation}:${sequence}:message`),
          role: "user",
          text: [
            `Durable watch ${watch.watchId} observed ${events.length} event${events.length === 1 ? "" : "s"}.`,
            `Summary: ${summary}`,
            "Raw events:",
            ...events.map((event) => `- ${event}`),
            `Inspect it with: t3 thread watch read ${watch.watchId} --json`,
          ].join("\n"),
          attachments: [],
          origin: {
            type: "watch",
            watchId: watch.watchId,
            generation,
            sequence,
            eventCount: events.length,
            decision,
            ...(summary.trim().length === 0 ? {} : { summary: summary.trim() }),
          },
        },
        runtimeMode: coordinator.value.runtimeMode,
        interactionMode: coordinator.value.interactionMode,
        delivery: "queued",
        createdAt,
      });
    }).pipe(
      Effect.mapError(
        toThreadOrchestrationError("watch.notify", { threadId: watch.coordinator.threadId }),
      ),
    );

  const startWatch = (
    scope: McpInvocationContext.McpInvocationScope,
    watchId: ThreadOrchestrationWatchId,
  ) =>
    Effect.gen(function* () {
      if (watchFibers.has(watchId)) return;
      const watch = yield* readWatch(scope, { watchId });
      if (watch.state !== "open") return;
      const coordinator = yield* resolveThreadSummary(watch.coordinator.threadId);
      if (["archived", "deleted"].includes(coordinator.status)) {
        yield* closeWatchInternal(scope, watch, "cancelled", "coordinator is not active", false);
        return;
      }
      const generation = watch.generation + 1;
      const startedAt = yield* nowIso;
      yield* appendCoordinationActivity({
        threadId: watch.coordinator.threadId,
        kind: "thread-orchestration.watch.started",
        summary: `Started durable watch generation ${generation}.`,
        payload: { kind: "started", watchId, generation, startedAt },
        createdAt: startedAt,
        stableId: `${watchId}:started:${generation}`,
      });
      const cwd = coordinator.worktreePath ?? coordinator.workspaceRoot;
      const gate = makeWatchFloodGate();
      const changed = makeWatchChangeGate();
      let sequence = watch.lastSequence;
      const runningWatch = { ...watch, generation };
      const onBatch = (events: [string, ...string[]]) =>
        Effect.gen(function* () {
          const pacing = gate.accept(yield* Clock.currentTimeMillis);
          if (pacing === "drop") return;
          if (pacing === "overloaded") {
            return yield* new WatchSourceError({
              detail: "Watch source exceeded the sustained event limit for 30 seconds.",
              retryable: false,
            });
          }
          const current = yield* readWatch(scope, { watchId }).pipe(
            Effect.mapError(
              (cause) =>
                new WatchSourceError({
                  detail: "Could not confirm current watch generation.",
                  retryable: false,
                  cause,
                }),
            ),
          );
          if (current.state !== "open" || current.generation !== generation) return;
          if (current.policy.type === "model" && !changed(events)) return;
          sequence += 1;
          const decision = yield* decideWatchBatch(current, cwd, events).pipe(
            Effect.mapError(
              (cause) =>
                new WatchSourceError({
                  detail: "Could not evaluate watch events.",
                  retryable: false,
                  cause,
                }),
            ),
          );
          const observedAt = yield* nowIso;
          yield* appendCoordinationActivity({
            threadId: watch.coordinator.threadId,
            kind: "thread-orchestration.watch.event",
            summary:
              decision.action === "ignore"
                ? "Watch event ignored by notification policy."
                : `Watch event will ${decision.action} the coordinator.`,
            payload: {
              kind: "event",
              watchId,
              generation,
              sequence,
              events,
              decision: decision.action,
              summary: decision.summary,
              observedAt,
            },
            createdAt: observedAt,
            stableId: `${watchId}:event:${generation}:${sequence}`,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new WatchSourceError({
                  detail: "Could not persist watch event.",
                  retryable: false,
                  cause,
                }),
            ),
          );
          if (decision.action === "ignore") return;
          yield* notifyWatch(
            current,
            generation,
            sequence,
            events,
            decision.action,
            decision.summary,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new WatchSourceError({
                  detail: "Could not queue watch notification.",
                  retryable: false,
                  cause,
                }),
            ),
          );
          if (decision.action === "close") {
            yield* closeWatchInternal(
              scope,
              current,
              "completed",
              "notification policy closed it",
              false,
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new WatchSourceError({
                    detail: "Could not close watch.",
                    retryable: false,
                    cause,
                  }),
              ),
            );
            return yield* new WatchSourceError({
              detail: "Watch closed by notification policy.",
              retryable: false,
            });
          }
        });

      const source = runWatchSource(watch.source, cwd, onBatch).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      );
      const deadlineAt = watch.deadlineAt;
      const deadline =
        deadlineAt === null
          ? Effect.never
          : Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) =>
                Effect.sleep(
                  Duration.millis(
                    Math.max(0, DateTime.toEpochMillis(DateTime.makeUnsafe(deadlineAt)) - now),
                  ),
                ),
              ),
              Effect.as("deadline" as const),
            );
      const run = Effect.raceFirst(source.pipe(Effect.as("source-exited" as const)), deadline).pipe(
        Effect.flatMap((reason) =>
          watchShutdown
            .unlessStopping(
              closeWatchInternal(
                scope,
                runningWatch,
                "completed",
                reason === "deadline" ? "deadline reached" : "source exited",
                false,
              ),
            )
            .pipe(Effect.asVoid),
        ),
        Effect.catch((error) => {
          const detail = Schema.is(WatchSourceError)(error) ? error.detail : error.message;
          return detail === "Watch closed by notification policy."
            ? Effect.void
            : watchShutdown
                .unlessStopping(closeWatchInternal(scope, runningWatch, "failed", detail, false))
                .pipe(Effect.asVoid);
        }),
        Effect.ensuring(
          Effect.sync(() => {
            watchFibers.delete(watchId);
          }),
        ),
      );
      // Defer execution until this fiber yields so the registry entry always
      // exists before a zero-deadline or fast-exiting source can clean it up.
      const fiber = yield* Effect.forkIn(run, watchScope, { startImmediately: false });
      watchFibers.set(watchId, fiber);
    });

  const createWatch = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationCreateWatchInput,
  ) =>
    Effect.gen(function* () {
      if (input.source.type === "websocket") {
        let protocol: string;
        try {
          protocol = new URL(input.source.url).protocol;
        } catch {
          protocol = "";
        }
        if (protocol !== "ws:" && protocol !== "wss:") {
          return yield* new ThreadOrchestrationError({
            operation: "create_watch",
            code: "invalid_websocket_url",
            message: "WebSocket watches require a ws:// or wss:// URL.",
            threadId: scope.threadId,
          });
        }
      }
      yield* resolveThreadSummary(scope.threadId);
      const currentEnvironmentId = yield* localEnvironmentId;
      const watchId = yield* makeId(
        crypto,
        "thread-orchestration:watch",
        ThreadOrchestrationWatchId.make,
      );
      const openedDateTime = yield* DateTime.now;
      const openedAt = DateTime.formatIso(openedDateTime);
      const deadlineMs =
        input.deadlineMs === undefined
          ? undefined
          : Math.min(input.deadlineMs, MAX_BATCH_TIMEOUT_MS);
      const watch: OrchestrationWatchShell = {
        watchId,
        coordinator: { environmentId: currentEnvironmentId, threadId: scope.threadId },
        source: input.source,
        policy: input.policy ?? { type: "always" },
        state: "open",
        generation: 0,
        lastSequence: 0,
        eventCount: 0,
        openedAt,
        deadlineAt:
          deadlineMs === undefined
            ? null
            : DateTime.formatIso(DateTime.add(openedDateTime, { milliseconds: deadlineMs })),
        lastEventAt: null,
        closedAt: null,
        lastSummary: null,
      };
      yield* appendCoordinationActivity({
        threadId: scope.threadId,
        kind: "thread-orchestration.watch.opened",
        summary: `Registered durable ${input.source.type} watch.`,
        payload: { kind: "opened", watch },
        createdAt: openedAt,
        stableId: `${watchId}:opened`,
      });
      yield* startWatch(scope, watchId);
      return { ...watch, generation: 1 };
    });

  const cancelWatch = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationCancelWatchInput,
  ) =>
    Effect.gen(function* () {
      const watch = yield* readWatch(scope, input);
      yield* assertCoordinator("cancel_watch", scope, watch.coordinator, "watch", input.watchId);
      return yield* closeWatchInternal(scope, watch, "cancelled", "cancelled by coordinator", true);
    });

  const monitorDelegatedThread = (
    scope: McpInvocationContext.McpInvocationScope,
    targetThreadId: ThreadId,
  ): Effect.Effect<void, ThreadOrchestrationError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* readThreadResult(scope, { threadId: targetThreadId });
        const outcome = result.thread.outcome ?? "unknown";
        const shouldWake =
          isTerminalBatchMemberOutcome(outcome) ||
          ["blocked-approval", "blocked-input"].includes(outcome);
        if (shouldWake) {
          const coordination = yield* coordinationShell();
          const coveredByWait = coordination.waits.some(
            (wait) =>
              wait.state === "open" &&
              wait.coordinator.threadId === scope.threadId &&
              wait.members.some((member) => member.thread.threadId === targetThreadId),
          );
          if (!coveredByWait) {
            const coordinator = yield* snapshotQuery
              .getThreadShellById(scope.threadId)
              .pipe(
                Effect.mapError(
                  toThreadOrchestrationError("delegation.notify", { threadId: scope.threadId }),
                ),
              );
            if (Option.isSome(coordinator)) {
              const createdAt = yield* nowIso;
              const stableId = `${scope.threadId}:${targetThreadId}:${outcome}`;
              yield* engine
                .dispatch({
                  type: "thread.message.queue",
                  commandId: CommandId.make(`${stableId}:message-command`),
                  threadId: scope.threadId,
                  message: {
                    messageId: MessageId.make(`${stableId}:message`),
                    role: "user",
                    text: [
                      `Delegated thread "${result.thread.title}" is ${outcome}.`,
                      `Thread: ${targetThreadId}`,
                      `Inspect it with: t3 thread result ${targetThreadId} --json`,
                    ].join("\n"),
                    attachments: [],
                  },
                  runtimeMode: coordinator.value.runtimeMode,
                  interactionMode: coordinator.value.interactionMode,
                  delivery: deliveryForCoordinatorNotification([outcome]),
                  createdAt,
                })
                .pipe(
                  Effect.mapError(
                    toThreadOrchestrationError("delegation.notify", {
                      threadId: scope.threadId,
                    }),
                  ),
                );
              yield* appendCoordinationActivity({
                threadId: scope.threadId,
                kind: "thread-orchestration.delegation.notified",
                summary: `Coordinator notified that ${targetThreadId} is ${outcome}.`,
                payload: { targetThreadId, outcome, notifiedAt: createdAt },
                createdAt,
                stableId: `${stableId}:notified`,
              });
            }
          }
          if (isTerminalBatchMemberOutcome(outcome) || coveredByWait) return;
        }
        const eventStream = Object.hasOwn(engine, "liveSubscriptionCapability")
          ? yield* engine.liveSubscriptionCapability!.subscribe
          : engine.streamDomainEvents;
        yield* eventStream.pipe(
          Stream.filter(
            (event) => event.aggregateKind === "thread" && event.aggregateId === targetThreadId,
          ),
          Stream.runHead,
        );
        return yield* monitorDelegatedThread(scope, targetThreadId);
      }),
    );

  const forkThread = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationForkThreadInput,
  ) =>
    Effect.gen(function* () {
      const sourceThreadId = input.threadId ?? scope.threadId;
      const sourceContext = yield* readThreadResultContext(sourceThreadId, "fork_thread");
      const sourceThread = sourceContext.thread;
      const project = sourceContext.project;
      const busyReason = forkSourceBusyReason(sourceContext);
      if (busyReason !== null) {
        return yield* new ThreadOrchestrationError({
          operation: "fork_thread",
          code: "source_busy",
          message: `Thread '${sourceThreadId}' cannot be forked right now because ${busyReason}. Wait until it is idle, then try again.`,
          threadId: sourceThreadId,
          projectId: sourceThread.projectId,
        });
      }
      const forkCoordination = input.coordination;
      const currentCoordination =
        forkCoordination?.effortId !== undefined ||
        forkCoordination?.excludeInheritedEffort === true ||
        snapshotQuery.getThreadCoordinationShell === undefined
          ? undefined
          : yield* coordinationShell();
      const inheritedEfforts =
        currentCoordination?.efforts.filter(
          (effort) => effort.coordinator.threadId === scope.threadId && effort.closedAt === null,
        ) ?? [];
      if (inheritedEfforts.length > 1) {
        return yield* new ThreadOrchestrationError({
          operation: "fork_thread",
          code: "ambiguous_effort",
          message:
            "This coordinator has more than one open effort. Choose one explicitly or disable effort inheritance.",
          threadId: scope.threadId,
        });
      }
      const effortId =
        forkCoordination?.effortId ??
        (forkCoordination?.excludeInheritedEffort === true
          ? undefined
          : inheritedEfforts[0]?.effortId);
      const effort = effortId === undefined ? undefined : yield* readEffort(scope, { effortId });
      if (effort !== undefined) {
        yield* assertCoordinator(
          "fork_thread",
          scope,
          effort.coordinator,
          "effort",
          effort.effortId,
        );
        if (effort.closedAt !== null) {
          return yield* new ThreadOrchestrationError({
            operation: "fork_thread",
            code: "effort_closed",
            message: `Effort '${effort.effortId}' is closed.`,
            threadId: scope.threadId,
            resourceType: "effort",
            resourceId: effort.effortId,
          });
        }
      }
      const createdAt = yield* nowIso;
      const nextThreadId = yield* threadId("fork");
      const title = `Fork of ${sourceThread.title}`;
      const recordCoordination = (thread: ThreadOrchestrationThreadSummary) =>
        Effect.gen(function* () {
          yield* appendRelationship({
            scope,
            kind: "createdBy",
            targetThreadId: nextThreadId,
            ...(effortId !== undefined ? { effortId } : {}),
            ...(forkCoordination?.label !== undefined
              ? { label: forkCoordination.label }
              : effortId !== undefined
                ? { label: title }
                : {}),
            summary: `Created by thread ${scope.threadId}.`,
            createdAt,
          });
          yield* appendRelationship({
            scope,
            actor: { environmentId: yield* localEnvironmentId, threadId: sourceThreadId },
            kind: "forkedFrom",
            targetThreadId: nextThreadId,
            summary: `Forked from thread ${sourceThreadId} by thread ${scope.threadId}.`,
            createdAt,
          });
          if (effortId === undefined || effort === undefined) return undefined;
          const member = {
            thread: { environmentId: thread.environmentId, threadId: nextThreadId },
            label: forkCoordination?.label ?? title,
            joinedAt: createdAt,
          };
          return { effortId, ...member };
        });
      const prepared =
        input.environment?.type === "worktree"
          ? yield* workspaceService
              .prepareWorkspace({
                threadId: nextThreadId,
                kind: "auto",
                roots: [
                  {
                    projectId: project.id,
                    sourcePath: project.workspaceRoot,
                    role: "primary",
                  },
                ],
                displayNameSeed: sourceThread.title,
                retentionPolicy: "explicit-delete",
              })
              .pipe(
                Effect.mapError(
                  toThreadOrchestrationError("fork_thread.prepare_workspace", {
                    threadId: nextThreadId,
                    projectId: project.id,
                  }),
                ),
              )
          : undefined;

      const cleanupPreparedWorkspace =
        prepared === undefined
          ? Effect.void
          : workspaceService
              .deleteWorkspace({
                workspaceId: prepared.workspace.id,
                force: true,
              })
              .pipe(Effect.catch(() => Effect.void));

      const codexFork = yield* codexThreadForkImporter
        .fork({
          threadId: nextThreadId,
          sourceThread,
          project,
          title,
          createdAt,
          ...(prepared !== undefined ? { preparedWorkspace: prepared } : {}),
        })
        .pipe(
          Effect.map((result) => ({ _tag: "Success" as const, result })),
          Effect.catch((error) =>
            isUnsupportedCodexForkSource(error)
              ? Effect.succeed({ _tag: "Unsupported" as const })
              : cleanupPreparedWorkspace.pipe(Effect.flatMap(() => Effect.fail(error))),
          ),
        );

      if (codexFork._tag === "Success") {
        const membership = yield* recordCoordination(codexFork.result.thread);
        return {
          thread: codexFork.result.thread,
          transcriptCloned: true,
          ...(membership === undefined ? {} : { membership }),
        };
      }

      yield* engine
        .dispatch({
          type: "thread.create",
          commandId: yield* commandId("thread-fork-create"),
          threadId: nextThreadId,
          projectId: project.id,
          title,
          modelSelection: sourceThread.modelSelection,
          runtimeMode: sourceThread.runtimeMode,
          interactionMode: sourceThread.interactionMode,
          ...(sourceThread.skillScope ? { skillPackIds: sourceThread.skillScope.packIds } : {}),
          branch: prepared?.compatibilityBranch ?? null,
          worktreePath: prepared?.compatibilityWorktreePath ?? sourceThread.worktreePath,
          workspaceId: prepared?.workspace.id ?? null,
          createdAt,
        })
        .pipe(
          Effect.mapError(
            toThreadOrchestrationError("fork_thread.dispatch", {
              threadId: nextThreadId,
              projectId: project.id,
            }),
          ),
          Effect.catch((error) =>
            cleanupPreparedWorkspace.pipe(Effect.flatMap(() => Effect.fail(error))),
          ),
        );
      const thread: ThreadOrchestrationThreadSummary = {
        environmentId: yield* localEnvironmentId,
        threadId: nextThreadId,
        projectId: project.id,
        title,
        projectTitle: project.title,
        status: "idle",
        modelSelection: sourceThread.modelSelection,
        runtimeMode: sourceThread.runtimeMode,
        interactionMode: sourceThread.interactionMode,
        workspaceRoot: project.workspaceRoot,
        worktreePath: prepared?.compatibilityWorktreePath ?? sourceThread.worktreePath,
        outcome: "queued" as const,
        backgroundLiveness: null,
        createdAt,
        updatedAt: createdAt,
      };
      const membership = yield* recordCoordination(thread);
      return {
        thread,
        transcriptCloned: false,
        ...(membership === undefined ? {} : { membership }),
      };
    });

  const sendMessageToThread = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationSendMessageInput,
  ) =>
    Effect.gen(function* () {
      if (yield* shouldRouteRemote(input.environmentId)) {
        return yield* remoteClient.sendMessageToThread(scopeForRemote(scope), input);
      }
      yield* assertExplicitModelSelectionAllowed("send_message_to_thread", input.modelSelection);
      yield* assertLegacyModelSelectionAllowed(
        "send_message_to_thread",
        input.modelSelection,
        input.allowLegacyModel,
      );
      const targetThreadOption = yield* snapshotQuery.getThreadShellById(input.threadId).pipe(
        Effect.mapError(
          toThreadOrchestrationError("send_message_to_thread.thread", {
            threadId: input.threadId,
          }),
        ),
      );
      if (Option.isNone(targetThreadOption)) {
        return yield* notFoundError("send_message_to_thread", "thread", input.threadId, {
          threadId: input.threadId,
        });
      }
      const targetThread = targetThreadOption.value;
      const createdAt = yield* nowIso;
      const sentMessageId = yield* messageId("thread-message");
      const delivery = input.delivery ?? "immediate";
      yield* engine
        .dispatch({
          type: "thread.message.queue",
          commandId: yield* commandId("thread-message-queue"),
          threadId: input.threadId,
          message: {
            messageId: sentMessageId,
            role: "user",
            text: input.prompt,
            attachments: [],
          },
          ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
          runtimeMode: input.runtimeMode ?? targetThread.runtimeMode,
          interactionMode: input.interactionMode ?? targetThread.interactionMode,
          delivery,
          createdAt,
        })
        .pipe(
          Effect.mapError(
            toThreadOrchestrationError("send_message_to_thread.dispatch", {
              threadId: input.threadId,
            }),
          ),
        );
      if (input.threadId !== scope.threadId) {
        yield* appendRelationship({
          scope,
          kind: "messagedBy",
          targetThreadId: input.threadId,
          summary: `Messaged by thread ${scope.threadId}.`,
          createdAt,
        });
      }
      const resultContextOption = yield* snapshotQuery
        .getThreadResultContextById(input.threadId)
        .pipe(
          Effect.mapError(
            toThreadOrchestrationError("send_message_to_thread.result", {
              threadId: input.threadId,
            }),
          ),
        );
      if (Option.isNone(resultContextOption)) {
        return yield* notFoundError("send_message_to_thread", "thread", input.threadId, {
          threadId: input.threadId,
        });
      }
      const queued = delivery === "queued" && resultContextOption.value.queuedMessageCount > 0;
      const thread = summaryForThread(
        resultContextOption.value.thread,
        resultContextOption.value.project,
        yield* localEnvironmentId,
      );
      return {
        thread,
        messageId: sentMessageId,
        disposition: queued ? ("queued" as const) : ("dispatched" as const),
        queued,
      };
    });

  const setThreadTitle = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationSetThreadTitleInput,
  ) =>
    Effect.gen(function* () {
      if (yield* shouldRouteRemote(input.environmentId)) {
        return yield* remoteClient.setThreadTitle(scopeForRemote(scope), input);
      }
      const createdAt = yield* nowIso;
      yield* engine
        .dispatch({
          type: "thread.meta.update",
          commandId: yield* commandId("thread-title"),
          threadId: input.threadId,
          title: input.title,
        })
        .pipe(
          Effect.mapError(
            toThreadOrchestrationError("set_thread_title.dispatch", {
              threadId: input.threadId,
            }),
          ),
        );
      if (input.threadId !== scope.threadId) {
        yield* appendRelationship({
          scope,
          kind: "renamedBy",
          targetThreadId: input.threadId,
          summary: `Renamed by thread ${scope.threadId}.`,
          createdAt,
        });
      }
      const summary = yield* resolveThreadSummary(input.threadId);
      return { ...summary, title: input.title, updatedAt: createdAt };
    });

  // Batch definitions and notification markers are durable activities. Rebuild
  // the small set of unfinished barriers when the server restarts.
  yield* Effect.gen(function* () {
    if (!Object.hasOwn(snapshotQuery, "listThreadOrchestrationBatchActivities")) return;
    const activities = yield* snapshotQuery.listThreadOrchestrationBatchActivities!().pipe(
      Effect.mapError(toThreadOrchestrationError("batch.recover")),
    );
    for (const definition of activities.flatMap(
      (activity) => batchDefinitionFromActivity(activity) ?? [],
    )) {
      if (hasBatchActivity(activities, "thread-orchestration.batch.notified", definition.batchId)) {
        continue;
      }
      const recoveryScope: McpInvocationContext.McpInvocationScope = {
        environmentId: definition.coordinatorEnvironmentId,
        threadId: definition.coordinatorThreadId,
        providerSessionId: "t3-batch-barrier",
        providerInstanceId: ProviderInstanceId.make("t3-batch-barrier"),
        capabilities: new Set(["threads"]),
        issuedAt: 0,
      };
      yield* monitorBatch(recoveryScope, definition.batchId).pipe(
        Effect.ignoreCause({ log: true }),
        Effect.forkDetach,
      );
    }
  }).pipe(Effect.ignoreCause({ log: true }));

  // Wait definitions are durable activities too. Reattach monitors for every
  // open local wait after a server restart.
  yield* Effect.gen(function* () {
    const coordination = yield* coordinationShell();
    const currentEnvironmentId = yield* localEnvironmentId;
    for (const wait of coordination.waits) {
      if (
        wait.state !== "open" ||
        (wait.coordinator.environmentId !== undefined &&
          wait.coordinator.environmentId !== currentEnvironmentId)
      ) {
        continue;
      }
      const recoveryScope: McpInvocationContext.McpInvocationScope = {
        environmentId: currentEnvironmentId,
        threadId: wait.coordinator.threadId,
        providerSessionId: "t3-effort-wait",
        providerInstanceId: ProviderInstanceId.make("t3-effort-wait"),
        capabilities: new Set(["threads"]),
        issuedAt: 0,
      };
      yield* monitorWait(recoveryScope, wait.waitId).pipe(
        Effect.ignoreCause({ log: true }),
        Effect.forkDetach,
      );
    }
  }).pipe(Effect.ignoreCause({ log: true }));

  // Watch definitions are durable. Starting a new execution generation makes
  // late output from a previous server process harmless.
  yield* Effect.gen(function* () {
    const coordination = yield* coordinationShell();
    const currentEnvironmentId = yield* localEnvironmentId;
    for (const watch of coordination.watches) {
      if (
        watch.state !== "open" ||
        (watch.coordinator.environmentId !== undefined &&
          watch.coordinator.environmentId !== currentEnvironmentId)
      ) {
        continue;
      }
      const recoveryScope: McpInvocationContext.McpInvocationScope = {
        environmentId: currentEnvironmentId,
        threadId: watch.coordinator.threadId,
        providerSessionId: "t3-durable-watch",
        providerInstanceId: ProviderInstanceId.make("t3-durable-watch"),
        capabilities: new Set(["threads"]),
        issuedAt: 0,
      };
      yield* startWatch(recoveryScope, watch.watchId);
    }
  }).pipe(Effect.ignoreCause({ log: true }));

  // Archiving or deleting the owner is an explicit way out. Interrupting a
  // provider turn is deliberately not: watches live independently of turns.
  yield* engine.streamDomainEvents.pipe(
    Stream.filter((event) => event.type === "thread.archived" || event.type === "thread.deleted"),
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        const coordination = yield* coordinationShell();
        const currentEnvironmentId = yield* localEnvironmentId;
        const scope: McpInvocationContext.McpInvocationScope = {
          environmentId: currentEnvironmentId,
          threadId: ThreadId.make(event.aggregateId),
          providerSessionId: "t3-durable-watch",
          providerInstanceId: ProviderInstanceId.make("t3-durable-watch"),
          capabilities: new Set(["threads"]),
          issuedAt: 0,
        };
        yield* Effect.forEach(
          coordination.watches.filter(
            (watch) => watch.state === "open" && watch.coordinator.threadId === event.aggregateId,
          ),
          (watch) =>
            closeWatchInternal(
              scope,
              watch,
              "cancelled",
              event.type === "thread.deleted" ? "coordinator deleted" : "coordinator archived",
              true,
            ),
          { concurrency: "unbounded", discard: true },
        );
      }).pipe(Effect.ignoreCause({ log: true })),
    ),
    Effect.forkDetach,
  );

  yield* Effect.gen(function* () {
    const currentEnvironmentId = yield* localEnvironmentId;
    const activities = yield* snapshotQuery
      .listThreadRelationshipActivities()
      .pipe(Effect.mapError(toThreadOrchestrationError("delegation.recover")));
    for (const relationship of activities.flatMap(
      (activity) => relationshipFromActivity(activity) ?? [],
    )) {
      if (
        relationship.kind !== "createdBy" ||
        relationship.wakeCoordinator !== true ||
        (relationship.actorEnvironmentId !== undefined &&
          relationship.actorEnvironmentId !== currentEnvironmentId) ||
        (relationship.targetEnvironmentId !== undefined &&
          relationship.targetEnvironmentId !== currentEnvironmentId)
      ) {
        continue;
      }
      const recoveryScope: McpInvocationContext.McpInvocationScope = {
        environmentId: currentEnvironmentId,
        threadId: relationship.actorThreadId,
        providerSessionId: "t3-delegation-monitor",
        providerInstanceId: ProviderInstanceId.make("t3-delegation-monitor"),
        capabilities: new Set(["threads"]),
        issuedAt: 0,
      };
      yield* monitorDelegatedThread(recoveryScope, relationship.targetThreadId).pipe(
        Effect.ignoreCause({ log: true }),
        Effect.forkDetach,
      );
    }
  }).pipe(Effect.ignoreCause({ log: true }));

  return ThreadOrchestrationService.of({
    listProjects,
    listThreadModels,
    listLocalProjects,
    listLocalThreadModels,
    listThreads,
    readThread,
    readThreadResult,
    getThreadGraph,
    createBatch,
    readBatch,
    cancelBatch,
    cleanupBatch,
    createEffort,
    readEffort,
    listEfforts,
    renameEffort,
    closeEffort,
    reopenEffort,
    addEffortMember,
    removeEffortMember,
    createWait,
    readWait,
    listWaits,
    cancelWait,
    createWatch,
    readWatch,
    listWatches,
    cancelWatch,
    stopThread,
    createThread,
    createRootThread,
    createThreadFromRemote,
    forkThread,
    sendMessageToThread,
    setThreadTitle,
  });
});

export const layer = Layer.effect(ThreadOrchestrationService, make);

export const __testing = {
  deliveryForCoordinatorNotification,
  isTerminalBatchMemberOutcome,
  isTerminalBatchStatus,
  statusForBatch,
};
