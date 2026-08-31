import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  type ProjectId,
  type ModelSelection,
  ThreadId,
  ThreadOrchestrationError,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type ThreadOrchestrationAwaitThreadInput,
  type ThreadOrchestrationAwaitThreadResult,
  type ThreadOrchestrationActorScope,
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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadWorkspaceService from "../../../workspace/ThreadWorkspaceService.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionThreadResultContext,
} from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import type * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CodexThreadForkImporter } from "./CodexThreadForkImporter.ts";
import { RemoteThreadOrchestrationClient } from "./RemoteThreadOrchestrationClient.ts";

const DEFAULT_THREAD_LIMIT = 20;
const MAX_THREAD_LIMIT = 100;
const DEFAULT_AWAIT_TIMEOUT_MS = 30_000;
const MAX_AWAIT_TIMEOUT_MS = 120_000;
const DEFAULT_AWAIT_POLL_INTERVAL_MS = 1_000;
const MIN_AWAIT_POLL_INTERVAL_MS = 100;

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
    readonly awaitThread: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationAwaitThreadInput,
    ) => Effect.Effect<ThreadOrchestrationAwaitThreadResult, ThreadOrchestrationError>;
    readonly getThreadGraph: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationThreadGraphInput,
    ) => Effect.Effect<ThreadOrchestrationThreadGraphResult, ThreadOrchestrationError>;
    readonly createThread: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationCreateThreadInput,
    ) => Effect.Effect<ThreadOrchestrationCreateThreadResult, ThreadOrchestrationError>;
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

function statusForThread(thread: ThreadSummarySource): string {
  if ("deletedAt" in thread && thread.deletedAt !== null) return "deleted";
  if (thread.archivedAt !== null) return "archived";
  if (thread.session !== null) return thread.session.status;
  if (thread.latestTurn !== null) return thread.latestTurn.state;
  return "idle";
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
    createdAt: candidate.createdAt,
  };
}

function awaitSatisfiedResult(
  context: ProjectionThreadResultContext,
  until: "idle" | "completed" | "queueDrained",
): boolean {
  switch (until) {
    case "idle":
      return !["running", "starting"].includes(statusForThread(context.thread));
    case "completed":
      return context.thread.latestTurn?.state === "completed";
    case "queueDrained":
      return (
        context.queuedMessageCount === 0 &&
        !["running", "starting"].includes(statusForThread(context.thread))
      );
  }
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const workspaceService = yield* ThreadWorkspaceService.ThreadWorkspaceService;
  const codexThreadForkImporter = yield* CodexThreadForkImporter;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const providerRegistry = yield* ProviderRegistry;
  const remoteClient = yield* RemoteThreadOrchestrationClient;
  const crypto = yield* Crypto.Crypto;

  const shellSnapshot = snapshotQuery
    .getShellSnapshot()
    .pipe(Effect.mapError(toThreadOrchestrationError("shell_snapshot")));

  const commandId = (tag: string) => makeId(crypto, `mcp:${tag}`, CommandId.make);
  const eventId = (tag: string) => makeId(crypto, `mcp:${tag}`, EventId.make);
  const messageId = (tag: string) => makeId(crypto, `mcp:${tag}`, MessageId.make);
  const threadId = (tag: string) => makeId(crypto, `mcp:${tag}`, ThreadId.make);
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

  const resolveCreateInput = (
    scope: McpInvocationContext.McpInvocationScope,
    sourceThread: OrchestrationThreadShell | undefined,
    input: ThreadOrchestrationCreateThreadInput,
  ): Effect.Effect<ResolvedCreateThreadInput, ThreadOrchestrationError> =>
    Effect.gen(function* () {
      const selectedModel = input.modelSelection ?? sourceThread?.modelSelection;
      if (selectedModel === undefined) {
        return yield* new ThreadOrchestrationError({
          operation: "create_thread",
          code: "model_selection_required",
          message:
            "create_thread requires modelSelection when the actor thread is not present in this environment.",
          threadId: scope.threadId,
          projectId: input.target?.projectId,
        });
      }
      return {
        ...input,
        modelSelection: selectedModel,
        runtimeMode: input.runtimeMode ?? sourceThread?.runtimeMode ?? "full-access",
        interactionMode: input.interactionMode ?? sourceThread?.interactionMode ?? "default",
      };
    });

  const appendRelationship = (input: {
    readonly scope: McpInvocationContext.McpInvocationScope;
    readonly kind: ThreadOrchestrationRelationshipKind;
    readonly targetThreadId: ThreadId;
    readonly summary: string;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      const activity: OrchestrationThreadActivity = {
        id: yield* eventId("thread-relationship"),
        tone: "tool",
        kind: "thread-orchestration.relationship",
        summary: input.summary,
        payload: {
          kind: input.kind,
          actorEnvironmentId: input.scope.environmentId,
          actorThreadId: input.scope.threadId,
          targetEnvironmentId: yield* localEnvironmentId,
          targetThreadId: input.targetThreadId,
          createdAt: input.createdAt,
        },
        turnId: null,
        createdAt: input.createdAt,
      };
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: yield* commandId("thread-relationship"),
        threadId: input.targetThreadId,
        activity,
        createdAt: input.createdAt,
      });
    }).pipe(
      Effect.mapError(
        toThreadOrchestrationError("relationship.append", { threadId: input.targetThreadId }),
      ),
    );

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
      const createdAt = yield* nowIso;
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

  const awaitThread = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationAwaitThreadInput,
  ) =>
    Effect.gen(function* () {
      if (yield* shouldRouteRemote(input.environmentId)) {
        return yield* remoteClient.awaitThread(scopeForRemote(scope), input);
      }
      const until = input.until ?? "idle";
      const timeoutMs = Math.min(input.timeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS, MAX_AWAIT_TIMEOUT_MS);
      const pollIntervalMs = Math.max(
        input.pollIntervalMs ?? DEFAULT_AWAIT_POLL_INTERVAL_MS,
        MIN_AWAIT_POLL_INTERVAL_MS,
      );
      const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;

      const poll: Effect.Effect<ThreadOrchestrationAwaitThreadResult, ThreadOrchestrationError> =
        Effect.gen(function* () {
          const context = yield* readThreadResultContext(input.threadId, "await_thread");
          const result = yield* threadResultFromContext(context);
          const satisfied = awaitSatisfiedResult(context, until);
          if (satisfied) {
            return { result, satisfied, timedOut: false };
          }
          if ((yield* Clock.currentTimeMillis) >= deadline) {
            return { result, satisfied: false, timedOut: true };
          }
          yield* Effect.sleep(Duration.millis(pollIntervalMs));
          return yield* poll;
        });

      return yield* poll;
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
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationCreateThreadInput,
    options: { readonly modelSelectionIntent: "explicit" | "inherited" },
  ) =>
    Effect.gen(function* () {
      const sourceThreadOption = yield* snapshotQuery.getThreadShellById(scope.threadId).pipe(
        Effect.mapError(
          toThreadOrchestrationError("create_thread.source", {
            threadId: scope.threadId,
          }),
        ),
      );
      const sourceThread = Option.getOrUndefined(sourceThreadOption);
      const resolvedInput = yield* resolveCreateInput(scope, sourceThread, input);
      if (options.modelSelectionIntent === "explicit") {
        yield* assertExplicitModelSelectionAllowed("create_thread", input.modelSelection);
      }
      if (yield* shouldRouteRemote(input.target?.environmentId)) {
        return yield* remoteClient.createThread(scopeForRemote(scope), resolvedInput);
      }
      if (!sourceThread && input.target?.projectId === undefined) {
        return yield* notFoundError("create_thread", "thread", scope.threadId, {
          threadId: scope.threadId,
        });
      }

      const projectId = input.target?.projectId ?? sourceThread?.projectId;
      if (projectId === undefined) {
        return yield* new ThreadOrchestrationError({
          operation: "create_thread",
          code: "project_required",
          message:
            "create_thread requires target.projectId when the actor thread is not present in this environment.",
          threadId: scope.threadId,
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
      const title = input.title ?? input.prompt.slice(0, 80);

      const environment = input.target?.environment ?? ({ type: "local" } as const);
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
                displayNameSeed: title,
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

      yield* appendRelationship({
        scope,
        kind: "createdBy",
        targetThreadId: nextThreadId,
        summary: `Created by thread ${scope.threadId}.`,
        createdAt,
      });

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
          createdAt,
          updatedAt: createdAt,
        },
        promptSubmitted: true,
      };
    });

  const createThread = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationCreateThreadInput,
  ) =>
    createThreadInternal(scope, input, {
      modelSelectionIntent: input.modelSelection === undefined ? "inherited" : "explicit",
    });

  const createThreadFromRemote = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationCreateThreadInput,
  ) =>
    createThreadInternal(scope, input, {
      modelSelectionIntent: input.modelSelection === undefined ? "inherited" : "explicit",
    });

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
      const createdAt = yield* nowIso;
      const nextThreadId = yield* threadId("fork");
      const title = `Fork of ${sourceThread.title}`;
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
                displayNameSeed: title,
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
        yield* appendRelationship({
          scope,
          kind: "forkedFrom",
          targetThreadId: nextThreadId,
          summary: `Forked from thread ${sourceThreadId} by thread ${scope.threadId}.`,
          createdAt,
        });
        return {
          thread: codexFork.result.thread,
          transcriptCloned: true,
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
      yield* appendRelationship({
        scope,
        kind: "forkedFrom",
        targetThreadId: nextThreadId,
        summary: `Forked from thread ${sourceThreadId} by thread ${scope.threadId}.`,
        createdAt,
      });
      return {
        thread: {
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
          createdAt,
          updatedAt: createdAt,
        },
        transcriptCloned: false,
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
      yield* engine
        .dispatch({
          type: "thread.message.queue",
          commandId: yield* commandId("thread-message-queue"),
          threadId: input.threadId,
          message: {
            messageId: yield* messageId("thread-message"),
            role: "user",
            text: input.prompt,
            attachments: [],
          },
          ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
          runtimeMode: input.runtimeMode ?? targetThread.runtimeMode,
          interactionMode: input.interactionMode ?? targetThread.interactionMode,
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
      const thread = yield* resolveThreadSummary(input.threadId);
      return { thread, queued: true };
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

  return ThreadOrchestrationService.of({
    listProjects,
    listThreadModels,
    listLocalProjects,
    listLocalThreadModels,
    listThreads,
    readThread,
    readThreadResult,
    awaitThread,
    getThreadGraph,
    createThread,
    createThreadFromRemote,
    forkThread,
    sendMessageToThread,
    setThreadTitle,
  });
});

export const layer = Layer.effect(ThreadOrchestrationService, make);
