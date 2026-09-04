import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  ThreadOrchestrationEffortId,
  ThreadOrchestrationError,
  ThreadWorkspaceId,
  ThreadWorkspaceRootId,
  type ServerProvider,
  type OrchestrationCommand,
  type ProjectId,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationCommandInvariantError } from "../../../orchestration/Errors.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as TextGeneration from "../../../textGeneration/TextGeneration.ts";
import * as ThreadWorkspaceService from "../../../workspace/ThreadWorkspaceService.ts";
import type * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CodexThreadForkImporter } from "./CodexThreadForkImporter.ts";
import { RemoteThreadOrchestrationClient } from "./RemoteThreadOrchestrationClient.ts";
import {
  __testing,
  ThreadOrchestrationService,
  layer as ThreadOrchestrationServiceLive,
} from "./service.ts";

const actorThreadId = ThreadId.make("thread-actor");
const targetThreadId = ThreadId.make("thread-target");
const forkEffortId = ThreadOrchestrationEffortId.make("effort-fork");
const projectId = "project-1" as OrchestrationProject["id"];
const workspaceId = ThreadWorkspaceId.make("workspace-fork");
const workspaceRootId = ThreadWorkspaceRootId.make("workspace-root-fork");
const projectDefaultModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
};
const actorModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.6-sol",
  options: [{ id: "reasoningEffort", value: "high" }] as const,
};
const actorRuntimeMode = "auto-accept-edits" as const;
const actorInteractionMode = "plan" as const;

it("keeps blocked batches open and cleanup-ineligible", () => {
  const outcomes = ["completed", "blocked-approval", "running"] as const;
  expect(__testing.statusForBatch({ cancelled: false, deadlineExceeded: false, outcomes })).toBe(
    "blocked",
  );
  expect(__testing.isTerminalBatchStatus("blocked")).toBe(false);
  expect(outcomes.every(__testing.isTerminalBatchMemberOutcome)).toBe(false);
});

it("settles mixed terminal worker outcomes as failed", () => {
  const outcomes = ["completed", "failed", "interrupted"] as const;
  expect(__testing.statusForBatch({ cancelled: false, deadlineExceeded: false, outcomes })).toBe(
    "failed",
  );
  expect(outcomes.every(__testing.isTerminalBatchMemberOutcome)).toBe(true);
});

it("steers attention and explicit wait outcomes while queuing routine settlements", () => {
  expect(__testing.deliveryForCoordinatorNotification(["failed"])).toBe("immediate");
  expect(__testing.deliveryForCoordinatorNotification(["blocked-approval"])).toBe("immediate");
  expect(__testing.deliveryForCoordinatorNotification(["blocked-input"])).toBe("immediate");
  expect(__testing.deliveryForCoordinatorNotification(["completed", "failed"])).toBe("immediate");
  expect(__testing.deliveryForCoordinatorNotification(["completed"])).toBe("queued");
  expect(__testing.deliveryForCoordinatorNotification(["interrupted"])).toBe("queued");
  expect(__testing.deliveryForCoordinatorNotification(["completed"], "wait")).toBe("immediate");
});

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: actorThreadId,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["threads"]),
  issuedAt: 1,
};

const project: OrchestrationProject = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo/project",
  defaultModelSelection: projectDefaultModelSelection,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
};

const makeThread = (id: typeof targetThreadId): OrchestrationThread => ({
  id,
  projectId,
  title: id === actorThreadId ? "Actor" : "Target",
  modelSelection: id === actorThreadId ? actorModelSelection : projectDefaultModelSelection,
  runtimeMode: id === actorThreadId ? actorRuntimeMode : "full-access",
  interactionMode: id === actorThreadId ? actorInteractionMode : "default",
  branch: null,
  worktreePath: null,
  workspaceId: null,
  latestTurn: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  queuedMessages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
});

const readModel: OrchestrationReadModel = {
  snapshotSequence: 1,
  projects: [project],
  threads: [makeThread(actorThreadId), makeThread(targetThreadId)],
  usageLimits: [],
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const makeThreadShell = (
  thread: OrchestrationThread,
): OrchestrationShellSnapshot["threads"][number] => ({
  id: thread.id,
  projectId: thread.projectId,
  title: thread.title,
  modelSelection: thread.modelSelection,
  runtimeMode: thread.runtimeMode,
  interactionMode: thread.interactionMode,
  branch: thread.branch,
  worktreePath: thread.worktreePath,
  workspaceId: thread.workspaceId,
  latestTurn: thread.latestTurn,
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
  archivedAt: thread.archivedAt,
  settledOverride: thread.settledOverride,
  settledAt: thread.settledAt,
  session: thread.session,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const shellSnapshot: OrchestrationShellSnapshot = {
  snapshotSequence: readModel.snapshotSequence,
  projects: readModel.projects.map(({ deletedAt: _deletedAt, ...project }) => project),
  threads: readModel.threads.map(makeThreadShell),
  usageLimits: readModel.usageLimits,
  updatedAt: readModel.updatedAt,
};

const getThreadResultContextById =
  (model: OrchestrationReadModel = readModel) =>
  (threadId: ThreadId) =>
    Effect.sync(() => {
      const thread = model.threads.find((candidate) => candidate.id === threadId);
      if (!thread || thread.deletedAt !== null) return Option.none();
      const project = model.projects.find(
        (candidate) => candidate.id === thread.projectId && candidate.deletedAt === null,
      );
      if (!project) return Option.none();
      const { deletedAt: _deletedAt, ...projectShell } = project;
      return Option.some({
        thread: makeThreadShell(thread),
        project: projectShell,
        latestMessage: thread.messages.at(-1) ?? null,
        latestAssistantMessage:
          thread.messages.findLast((message) => message.role === "assistant") ?? null,
        queuedMessageCount: thread.queuedMessages?.length ?? 0,
        activityCount: thread.activities.length,
      });
    });

const getProjectShellById =
  (model: OrchestrationReadModel = readModel) =>
  (projectId: ProjectId) =>
    Effect.sync(() => {
      const project = model.projects.find(
        (candidate) => candidate.id === projectId && candidate.deletedAt === null,
      );
      if (!project) return Option.none();
      const { deletedAt: _deletedAt, ...projectShell } = project;
      return Option.some(projectShell);
    });

const getThreadShellById =
  (model: OrchestrationReadModel = readModel) =>
  (threadId: ThreadId) =>
    Effect.sync(() => {
      const thread = model.threads.find(
        (candidate) =>
          candidate.id === threadId &&
          candidate.deletedAt === null &&
          candidate.archivedAt === null,
      );
      return thread ? Option.some(makeThreadShell(thread)) : Option.none();
    });

const getThreadDetailById =
  (model: OrchestrationReadModel = readModel) =>
  (threadId: ThreadId) =>
    Effect.sync(() => {
      const thread = model.threads.find(
        (candidate) =>
          candidate.id === threadId &&
          candidate.deletedAt === null &&
          candidate.archivedAt === null,
      );
      return thread ? Option.some(thread) : Option.none();
    });

const listThreadRelationshipActivities =
  (model: OrchestrationReadModel = readModel) =>
  () =>
    Effect.sync(() =>
      model.threads.flatMap((thread) =>
        thread.activities.filter(
          (activity) => activity.kind === "thread-orchestration.relationship",
        ),
      ),
    );

const makeShellSnapshot = (
  model: OrchestrationReadModel,
  archived: boolean,
): OrchestrationShellSnapshot => ({
  snapshotSequence: model.snapshotSequence,
  projects: model.projects
    .filter((project) => project.deletedAt === null)
    .map(({ deletedAt: _deletedAt, ...project }) => project),
  threads: model.threads
    .filter(
      (thread) =>
        thread.deletedAt === null &&
        (archived ? thread.archivedAt !== null : thread.archivedAt === null),
    )
    .map(makeThreadShell),
  usageLimits: model.usageLimits,
  updatedAt: model.updatedAt,
});

const unsupportedCodexForkImporterLayer = Layer.succeed(CodexThreadForkImporter, {
  fork: (input) =>
    Effect.fail(
      new ThreadOrchestrationError({
        operation: "fork_thread.codex",
        code: "unsupported_source",
        message: `Thread '${input.sourceThread.id}' is not backed by Codex.`,
        threadId: input.sourceThread.id,
      }),
    ),
});

const remoteThreadOrchestrationClientLayer = Layer.succeed(RemoteThreadOrchestrationClient, {
  listProjects: () => Effect.succeed({ environments: [] }),
  listThreadModels: () => Effect.succeed({ models: [] }),
  listThreads: () => Effect.die("unused remote listThreads"),
  readThread: () => Effect.die("unused remote readThread"),
  readThreadResult: () => Effect.die("unused remote readThreadResult"),
  getThreadGraph: () => Effect.die("unused remote getThreadGraph"),
  createThread: () => Effect.die("unused remote createThread"),
  createRootThread: () => Effect.die("unused remote createRootThread"),
  sendMessageToThread: () => Effect.die("unused remote sendMessageToThread"),
  setThreadTitle: () => Effect.die("unused remote setThreadTitle"),
});

const providerSnapshots: ServerProvider[] = [
  {
    instanceId: ProviderInstanceId.make("codex"),
    driver: "codex" as ServerProvider["driver"],
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [
      {
        slug: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "gpt-5.4",
        name: "GPT-5.4",
        isCustom: false,
        isLegacy: true,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select",
              options: [
                { id: "low", label: "Low" },
                { id: "medium", label: "Medium" },
                { id: "high", label: "High", isDefault: true },
                { id: "xhigh", label: "Extra High" },
              ],
              currentValue: "high",
            },
          ],
        },
      },
      {
        slug: "gpt-5.3-codex-spark",
        name: "Spark",
        isCustom: false,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
  },
  {
    instanceId: ProviderInstanceId.make("cursor"),
    driver: "cursor" as ServerProvider["driver"],
    displayName: "Cursor",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    requiresNewThreadForModelChange: true,
    models: [
      {
        slug: "composer-2",
        name: "Composer 2",
        isCustom: false,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
  },
  {
    instanceId: ProviderInstanceId.make("opencode"),
    driver: "opencode" as ServerProvider["driver"],
    displayName: "OpenCode",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [
      {
        slug: "openai/gpt-5",
        name: "OpenAI GPT-5",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "openai/gpt-5.4-mini-fast",
        name: "OpenAI GPT-5.4 Mini Fast",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "openai/gpt-5.3-codex-spark",
        name: "OpenAI GPT-5.3 Codex Spark",
        isCustom: false,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
  },
];

const makeTestThreadDiscoveryDependencies = (
  remoteClientLayer: Layer.Layer<RemoteThreadOrchestrationClient> = remoteThreadOrchestrationClientLayer,
) =>
  Layer.mergeAll(
    NodeServices.layer,
    ServerSettings.layerTest(),
    Layer.succeed(
      TextGeneration.TextGeneration,
      TextGeneration.TextGeneration.of({
        generateCommitMessage: () => Effect.die("unused commit message generation"),
        generatePrContent: () => Effect.die("unused change request generation"),
        generateBranchName: () => Effect.die("unused branch name generation"),
        generateThreadTitle: () => Effect.die("unused thread title generation"),
        generateNotification: () => Effect.die("unused notification generation"),
      }),
    ),
    remoteClientLayer,
    Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(scope.environmentId),
      getDescriptor: Effect.succeed({
        environmentId: scope.environmentId,
        label: "MacBook",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      } as const),
    }),
    Layer.succeed(ProviderRegistry, {
      getProviders: Effect.succeed(providerSnapshots),
      refresh: () => Effect.succeed(providerSnapshots),
      refreshInstance: () => Effect.succeed(providerSnapshots),
      refreshWorkspaceSnapshot: () => Effect.succeed(providerSnapshots),
      getProviderMaintenanceCapabilitiesForInstance: () =>
        Effect.die("unused provider maintenance capabilities"),
      setProviderMaintenanceActionState: () => Effect.succeed(providerSnapshots),
      streamChanges: Stream.empty,
    }),
  );
const testThreadDiscoveryDependencies = makeTestThreadDiscoveryDependencies();

it.effect("lists thread model choices with curated model selections and reasoning options", () => {
  const testLayer = ThreadOrchestrationServiceLive.pipe(
    Layer.provide(unsupportedCodexForkImporterLayer),
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        resolveReceipt: () => Effect.succeed(Option.none()),
        dispatch: () => Effect.die("unused"),
        latestSequence: Effect.succeed(0),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed(readModel),
        getSnapshot: () => Effect.die("full snapshot should not be read"),
        getShellSnapshot: () => Effect.succeed(shellSnapshot),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
        getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 2 }),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: getProjectShellById(),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: getThreadShellById(),
        getThreadResultContextById: getThreadResultContextById(),
        listThreadRelationshipActivities: listThreadRelationshipActivities(),
        getThreadDetailById: getThreadDetailById(),
        getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
        getTurnActivitiesSnapshot: () => Effect.succeed(Option.none()),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
    ),
    Layer.provide(
      Layer.succeed(ThreadWorkspaceService.ThreadWorkspaceService, {
        prepareWorkspace: () => Effect.die("unused"),
        resolvePrimaryCwd: () => Effect.succeed(undefined as string | undefined),
        deleteWorkspace: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(testThreadDiscoveryDependencies),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadOrchestrationService;
    const result = yield* service.listThreadModels();

    expect(result.models).toEqual([
      {
        environmentId: scope.environmentId,
        provider: "Codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        driver: "codex",
        model: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
        },
      },
      {
        environmentId: scope.environmentId,
        provider: "Codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        driver: "codex",
        model: "gpt-5.4",
        name: "GPT-5.4",
        isLegacy: true,
        reasoning: {
          optionId: "reasoningEffort",
          values: ["low", "medium", "high", "xhigh"],
          defaultValue: "high",
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
      },
      {
        environmentId: scope.environmentId,
        provider: "Cursor",
        providerInstanceId: ProviderInstanceId.make("cursor"),
        driver: "cursor",
        model: "composer-2",
        name: "Composer 2",
        modelSelection: {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "composer-2",
        },
      },
      {
        environmentId: scope.environmentId,
        provider: "OpenCode",
        providerInstanceId: ProviderInstanceId.make("opencode"),
        driver: "opencode",
        model: "openai/gpt-5",
        name: "OpenAI GPT-5",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      },
    ]);
  }).pipe(Effect.provide(testLayer));
});

it.effect("lists environments and projects without provider model metadata", () => {
  const testLayer = ThreadOrchestrationServiceLive.pipe(
    Layer.provide(unsupportedCodexForkImporterLayer),
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        resolveReceipt: () => Effect.succeed(Option.none()),
        dispatch: () => Effect.die("unused"),
        latestSequence: Effect.succeed(0),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed(readModel),
        getSnapshot: () => Effect.die("full snapshot should not be read"),
        getShellSnapshot: () => Effect.succeed(shellSnapshot),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
        getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 2 }),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: getProjectShellById(),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: getThreadShellById(),
        getThreadResultContextById: getThreadResultContextById(),
        listThreadRelationshipActivities: listThreadRelationshipActivities(),
        getThreadDetailById: getThreadDetailById(),
        getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
        getTurnActivitiesSnapshot: () => Effect.succeed(Option.none()),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
    ),
    Layer.provide(
      Layer.succeed(ThreadWorkspaceService.ThreadWorkspaceService, {
        prepareWorkspace: () => Effect.die("unused"),
        resolvePrimaryCwd: () => Effect.succeed(undefined as string | undefined),
        deleteWorkspace: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(testThreadDiscoveryDependencies),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadOrchestrationService;
    const result = yield* service.listProjects();

    expect(result.environments).toEqual([
      {
        environmentId: scope.environmentId,
        label: "MacBook",
        remoteRouting: "currentEnvironmentOnly",
        canCreateLocalThreads: true,
        canCreateWorktreeThreads: true,
        projects: [
          {
            projectId,
            title: "Project",
            workspaceRoot: "/repo/project",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    ]);
  }).pipe(Effect.provide(testLayer));
});

it.effect("keeps local discovery separate from aggregate remote discovery", () => {
  const remoteEnvironmentId = EnvironmentId.make("environment-remote");
  const remoteClientLayer = Layer.succeed(RemoteThreadOrchestrationClient, {
    listProjects: () =>
      Effect.succeed({
        environments: [
          {
            environmentId: remoteEnvironmentId,
            label: "srv-2",
            remoteRouting: "registeredRemote" as const,
            canCreateLocalThreads: true,
            canCreateWorktreeThreads: true,
            projects: [
              {
                projectId: "remote-project" as OrchestrationProject["id"],
                title: "Remote Project",
                workspaceRoot: "/srv/project",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          },
        ],
      }),
    listThreadModels: () =>
      Effect.succeed({
        models: [
          {
            environmentId: remoteEnvironmentId,
            provider: "Codex",
            providerInstanceId: ProviderInstanceId.make("remote-codex"),
            driver: providerSnapshots[0]!.driver,
            model: "gpt-5.5",
            name: "GPT-5.5",
            modelSelection: {
              instanceId: ProviderInstanceId.make("remote-codex"),
              model: "gpt-5.5",
            },
          },
        ],
      }),
    listThreads: () => Effect.die("unused remote listThreads"),
    readThread: () => Effect.die("unused remote readThread"),
    readThreadResult: () => Effect.die("unused remote readThreadResult"),
    getThreadGraph: () => Effect.die("unused remote getThreadGraph"),
    createThread: () => Effect.die("unused remote createThread"),
    createRootThread: () => Effect.die("unused remote createRootThread"),
    sendMessageToThread: () => Effect.die("unused remote sendMessageToThread"),
    setThreadTitle: () => Effect.die("unused remote setThreadTitle"),
  });
  const testLayer = ThreadOrchestrationServiceLive.pipe(
    Layer.provide(unsupportedCodexForkImporterLayer),
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        resolveReceipt: () => Effect.succeed(Option.none()),
        dispatch: () => Effect.die("unused"),
        latestSequence: Effect.succeed(0),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed(readModel),
        getSnapshot: () => Effect.die("full snapshot should not be read"),
        getShellSnapshot: () => Effect.succeed(shellSnapshot),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
        getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 2 }),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: getProjectShellById(),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: getThreadShellById(),
        getThreadResultContextById: getThreadResultContextById(),
        listThreadRelationshipActivities: listThreadRelationshipActivities(),
        getThreadDetailById: getThreadDetailById(),
        getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
        getTurnActivitiesSnapshot: () => Effect.succeed(Option.none()),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
    ),
    Layer.provide(
      Layer.succeed(ThreadWorkspaceService.ThreadWorkspaceService, {
        prepareWorkspace: () => Effect.die("unused"),
        resolvePrimaryCwd: () => Effect.succeed(undefined as string | undefined),
        deleteWorkspace: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(makeTestThreadDiscoveryDependencies(remoteClientLayer)),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadOrchestrationService;
    const localProjects = yield* service.listLocalProjects();
    const aggregateProjects = yield* service.listProjects();
    const localModels = yield* service.listLocalThreadModels();
    const aggregateModels = yield* service.listThreadModels();

    expect(localProjects.environments.map((environment) => environment.environmentId)).toEqual([
      scope.environmentId,
    ]);
    expect(aggregateProjects.environments.map((environment) => environment.environmentId)).toEqual([
      scope.environmentId,
      remoteEnvironmentId,
    ]);
    expect(localModels.models.map((model) => model.environmentId)).toEqual([
      scope.environmentId,
      scope.environmentId,
      scope.environmentId,
      scope.environmentId,
    ]);
    expect(aggregateModels.models.map((model) => model.environmentId)).toEqual([
      scope.environmentId,
      scope.environmentId,
      scope.environmentId,
      scope.environmentId,
      remoteEnvironmentId,
    ]);
  }).pipe(Effect.provide(testLayer));
});

it.effect("delivers cross-thread messages with explicit queue control", () => {
  const dispatched: OrchestrationCommand[] = [];
  let queuedMessageCount = 0;
  const model: OrchestrationReadModel = {
    ...readModel,
    threads: [
      makeThread(actorThreadId),
      {
        ...makeThread(targetThreadId),
        runtimeMode: "approval-required",
        interactionMode: "default",
      },
    ],
  };
  const testLayer = ThreadOrchestrationServiceLive.pipe(
    Layer.provide(unsupportedCodexForkImporterLayer),
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        resolveReceipt: () => Effect.succeed(Option.none()),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            if (command.type === "thread.message.queue" && command.delivery === "queued") {
              queuedMessageCount += 1;
            }
            return { sequence: dispatched.length };
          }),
        latestSequence: Effect.succeed(0),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed(model),
        getSnapshot: () => Effect.die("full snapshot should not be read"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
        getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 2 }),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: getProjectShellById(model),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: getThreadShellById(model),
        getThreadResultContextById: (threadId) =>
          getThreadResultContextById(model)(threadId).pipe(
            Effect.map(
              Option.map((context) => ({
                ...context,
                queuedMessageCount,
              })),
            ),
          ),
        listThreadRelationshipActivities: listThreadRelationshipActivities(model),
        getThreadDetailById: getThreadDetailById(model),
        getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
        getTurnActivitiesSnapshot: () => Effect.succeed(Option.none()),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
    ),
    Layer.provide(
      Layer.succeed(ThreadWorkspaceService.ThreadWorkspaceService, {
        prepareWorkspace: () => Effect.die("unused"),
        resolvePrimaryCwd: () => Effect.succeed(undefined as string | undefined),
        deleteWorkspace: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(testThreadDiscoveryDependencies),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadOrchestrationService;
    const legacyModelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    };
    const legacyError = yield* service
      .sendMessageToThread(scope, {
        threadId: targetThreadId,
        prompt: "Please switch to the legacy model.",
        modelSelection: legacyModelSelection,
      })
      .pipe(Effect.flip);

    expect(legacyError).toMatchObject({
      operation: "send_message_to_thread",
      code: "legacy_model_not_allowed",
      resourceId: "gpt-5.4",
    });
    expect(dispatched).toHaveLength(0);

    const result = yield* service.sendMessageToThread(scope, {
      threadId: targetThreadId,
      prompt: "Please review the plan.",
    });

    expect(result.thread.threadId).toBe(targetThreadId);
    expect(result.messageId).toBe(
      dispatched[0]?.type === "thread.message.queue" ? dispatched[0].message.messageId : undefined,
    );
    expect(result.disposition).toBe("dispatched");
    expect(result.queued).toBe(false);
    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.message.queue",
      "thread.activity.append",
    ]);
    expect(dispatched[0]).toMatchObject({
      type: "thread.message.queue",
      threadId: targetThreadId,
      message: { text: "Please review the plan." },
      runtimeMode: "approval-required",
      interactionMode: "default",
      delivery: "immediate",
    });
    expect(dispatched[1]).toMatchObject({
      type: "thread.activity.append",
      threadId: targetThreadId,
      activity: {
        kind: "thread-orchestration.relationship",
        payload: {
          kind: "messagedBy",
          actorThreadId,
          targetThreadId,
        },
      },
    });
    expect((dispatched[0] as { commandId: CommandId }).commandId).not.toBe(
      (dispatched[1] as { commandId: CommandId }).commandId,
    );

    const queuedResult = yield* service.sendMessageToThread(scope, {
      threadId: targetThreadId,
      prompt: "After the implementation, update the docs.",
      delivery: "queued",
    });

    expect(queuedResult.disposition).toBe("queued");
    expect(queuedResult.queued).toBe(true);
    expect(dispatched[2]).toMatchObject({
      type: "thread.message.queue",
      threadId: targetThreadId,
      delivery: "queued",
    });

    yield* service.sendMessageToThread(scope, {
      threadId: targetThreadId,
      prompt: "Please run the compatibility check.",
      modelSelection: legacyModelSelection,
      allowLegacyModel: true,
    });

    expect(dispatched[4]).toMatchObject({
      type: "thread.message.queue",
      threadId: targetThreadId,
      modelSelection: legacyModelSelection,
      delivery: "immediate",
    });
  }).pipe(Effect.provide(testLayer));
});

it.effect("rejects hidden and legacy models unless legacy use is explicit", () => {
  const dispatched: OrchestrationCommand[] = [];
  const hiddenModelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.3-codex-spark",
  };
  const providerQualifiedHiddenModelSelection = {
    instanceId: ProviderInstanceId.make("opencode"),
    model: "openai/gpt-5.4-mini-fast",
  };
  const legacyModelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  };
  const testLayer = ThreadOrchestrationServiceLive.pipe(
    Layer.provide(unsupportedCodexForkImporterLayer),
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        resolveReceipt: () => Effect.succeed(Option.none()),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
        latestSequence: Effect.succeed(0),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed(readModel),
        getSnapshot: () => Effect.die("full snapshot should not be read"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
        getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 2 }),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: getProjectShellById(),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: getThreadShellById(),
        getThreadResultContextById: getThreadResultContextById(),
        listThreadRelationshipActivities: listThreadRelationshipActivities(),
        getThreadDetailById: getThreadDetailById(),
        getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
        getTurnActivitiesSnapshot: () => Effect.succeed(Option.none()),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
    ),
    Layer.provide(
      Layer.succeed(ThreadWorkspaceService.ThreadWorkspaceService, {
        prepareWorkspace: () => Effect.die("unused"),
        resolvePrimaryCwd: () => Effect.succeed(undefined as string | undefined),
        deleteWorkspace: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(testThreadDiscoveryDependencies),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadOrchestrationService;
    const error = yield* service
      .createThread(scope, {
        prompt: "Please review with the hidden model.",
        modelSelection: hiddenModelSelection,
      })
      .pipe(Effect.flip);

    expect(error).toMatchObject({
      operation: "create_thread",
      code: "model_not_selectable",
      resourceType: "model",
      resourceId: "gpt-5.3-codex-spark",
    });

    const providerQualifiedError = yield* service
      .createThread(scope, {
        prompt: "Please review with the provider-qualified hidden model.",
        modelSelection: providerQualifiedHiddenModelSelection,
      })
      .pipe(Effect.flip);

    expect(providerQualifiedError).toMatchObject({
      operation: "create_thread",
      code: "model_not_selectable",
      resourceType: "model",
      resourceId: "openai/gpt-5.4-mini-fast",
    });

    const explicitLegacyError = yield* service
      .createThread(scope, {
        prompt: "Please review with the legacy model.",
        modelSelection: legacyModelSelection,
      })
      .pipe(Effect.flip);

    expect(explicitLegacyError).toMatchObject({
      operation: "create_thread",
      code: "legacy_model_not_allowed",
      resourceType: "model",
      resourceId: "gpt-5.4",
    });

    const inheritedLegacyError = yield* service
      .createThread(
        { ...scope, threadId: targetThreadId },
        { prompt: "Please review with inherited legacy settings." },
      )
      .pipe(Effect.flip);

    expect(inheritedLegacyError).toMatchObject({
      operation: "create_thread",
      code: "legacy_model_not_allowed",
      resourceId: "gpt-5.4",
    });

    const allowedLegacyResult = yield* service.createThread(scope, {
      prompt: "Please run the compatibility check.",
      modelSelection: legacyModelSelection,
      allowLegacyModel: true,
    });

    expect(allowedLegacyResult.thread.modelSelection).toEqual(legacyModelSelection);

    const result = yield* service.createThread(scope, {
      prompt: "Please review with inherited settings.",
    });

    expect(result.thread.modelSelection).toEqual(actorModelSelection);
    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.turn.start",
      "thread.activity.append",
      "thread.create",
      "thread.turn.start",
      "thread.activity.append",
    ]);
  }).pipe(Effect.provide(testLayer));
});

it.effect("rejects hidden model selections sent through remote creation", () => {
  const remoteEnvironmentId = EnvironmentId.make("environment-remote");
  const hiddenModelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.3-codex-spark",
  };
  const remoteInputs: Parameters<RemoteThreadOrchestrationClient["Service"]["createThread"]>[1][] =
    [];
  const remoteClientLayer = Layer.succeed(RemoteThreadOrchestrationClient, {
    listProjects: () => Effect.succeed({ environments: [] }),
    listThreadModels: () => Effect.succeed({ models: [] }),
    listThreads: () => Effect.die("unused remote listThreads"),
    readThread: () => Effect.die("unused remote readThread"),
    readThreadResult: () => Effect.die("unused remote readThreadResult"),
    getThreadGraph: () => Effect.die("unused remote getThreadGraph"),
    createThread: (_remoteScope, input) =>
      Effect.sync(() => {
        remoteInputs.push(input);
        return {
          thread: {
            environmentId: remoteEnvironmentId,
            threadId: ThreadId.make("remote-thread"),
            projectId,
            title: input.title ?? "Remote Reviewer",
            projectTitle: "Remote Project",
            status: "running" as const,
            modelSelection: input.modelSelection ?? hiddenModelSelection,
            runtimeMode: input.runtimeMode ?? "full-access",
            interactionMode: input.interactionMode ?? "default",
            workspaceRoot: "/srv/project",
            worktreePath: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          promptSubmitted: true,
        };
      }),
    createRootThread: () => Effect.die("unused remote createRootThread"),
    sendMessageToThread: () => Effect.die("unused remote sendMessageToThread"),
    setThreadTitle: () => Effect.die("unused remote setThreadTitle"),
  });
  const testLayer = ThreadOrchestrationServiceLive.pipe(
    Layer.provide(unsupportedCodexForkImporterLayer),
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        resolveReceipt: () => Effect.succeed(Option.none()),
        dispatch: () => Effect.die("unused"),
        latestSequence: Effect.succeed(0),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed(readModel),
        getSnapshot: () => Effect.die("full snapshot should not be read"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
        getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 2 }),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: getProjectShellById(),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: getThreadShellById(),
        getThreadResultContextById: getThreadResultContextById(),
        listThreadRelationshipActivities: listThreadRelationshipActivities(),
        getThreadDetailById: getThreadDetailById(),
        getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
        getTurnActivitiesSnapshot: () => Effect.succeed(Option.none()),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
    ),
    Layer.provide(
      Layer.succeed(ThreadWorkspaceService.ThreadWorkspaceService, {
        prepareWorkspace: () => Effect.die("unused"),
        resolvePrimaryCwd: () => Effect.succeed(undefined as string | undefined),
        deleteWorkspace: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(makeTestThreadDiscoveryDependencies(remoteClientLayer)),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadOrchestrationService;
    const error = yield* service
      .createThreadFromRemote(scope, {
        prompt: "Please review remotely with hidden settings.",
        target: { projectId },
        modelSelection: hiddenModelSelection,
      })
      .pipe(Effect.flip);

    expect(error).toMatchObject({
      operation: "create_thread",
      code: "model_not_selectable",
    });
    expect(remoteInputs).toHaveLength(0);
  }).pipe(Effect.provide(testLayer));
});

it.effect("uses generated names for worktree threads before starting their initial turn", () => {
  const dispatched: OrchestrationCommand[] = [];
  const preparedInputs: Parameters<
    ThreadWorkspaceService.ThreadWorkspaceService["Service"]["prepareWorkspace"]
  >[0][] = [];
  const testLayer = ThreadOrchestrationServiceLive.pipe(
    Layer.provide(unsupportedCodexForkImporterLayer),
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        resolveReceipt: () => Effect.succeed(Option.none()),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
        latestSequence: Effect.succeed(0),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed(readModel),
        getSnapshot: () => Effect.die("full snapshot should not be read"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
        getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 2 }),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: getProjectShellById(),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: getThreadShellById(),
        getThreadResultContextById: getThreadResultContextById(),
        listThreadRelationshipActivities: listThreadRelationshipActivities(),
        getThreadDetailById: getThreadDetailById(),
        getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
        getTurnActivitiesSnapshot: () => Effect.succeed(Option.none()),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
    ),
    Layer.provide(
      Layer.succeed(ThreadWorkspaceService.ThreadWorkspaceService, {
        prepareWorkspace: (input) =>
          Effect.sync(() => {
            preparedInputs.push(input);
            return {
              workspace: {
                id: workspaceId,
                kind: "jj-workspace",
                lifecycle: "active",
                displayName: input.displayNameSeed ?? "Workspace",
                managed: true,
                primaryRootId: workspaceRootId,
                roots: [],
                createdForThreadId: input.threadId,
                retentionPolicy: "explicit-delete",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                deletedAt: null,
                failureDetail: null,
                metadata: {},
              },
              primaryCwd: "/repo/project-worktree",
              compatibilityWorktreePath: "/repo/project-worktree",
              compatibilityBranch: "feature/review",
            };
          }),
        resolvePrimaryCwd: () => Effect.succeed(undefined as string | undefined),
        deleteWorkspace: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(
      Layer.mock(TextGeneration.TextGeneration)({
        generateThreadTitle: () => Effect.succeed({ title: "Implementation Review" }),
      }),
    ),
    Layer.provide(testThreadDiscoveryDependencies),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadOrchestrationService;
    const result = yield* service.createThread(scope, {
      prompt: "Please review the implementation.",
      target: { environment: { type: "worktree" } },
    });

    expect(result.promptSubmitted).toBe(true);
    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.turn.start",
      "thread.activity.append",
    ]);
    expect(dispatched[0]).toMatchObject({
      type: "thread.create",
      threadId: result.thread.threadId,
      projectId,
      title: "Implementation Review",
      modelSelection: actorModelSelection,
      runtimeMode: actorRuntimeMode,
      interactionMode: actorInteractionMode,
      branch: "feature/review",
      worktreePath: "/repo/project-worktree",
      workspaceId,
    });
    expect(preparedInputs).toMatchObject([
      {
        threadId: result.thread.threadId,
        roots: [{ projectId, sourcePath: "/repo/project", role: "primary" }],
        displayNameSeed: "Implementation Review",
      },
    ]);
    expect(dispatched[1]).toMatchObject({
      type: "thread.turn.start",
      threadId: result.thread.threadId,
      message: { text: "Please review the implementation." },
      modelSelection: actorModelSelection,
      runtimeMode: actorRuntimeMode,
      interactionMode: actorInteractionMode,
    });
    expect(dispatched[1]).not.toHaveProperty("bootstrap");
    expect(dispatched[2]).toMatchObject({
      type: "thread.activity.append",
      threadId: result.thread.threadId,
      activity: {
        kind: "thread-orchestration.relationship",
        payload: {
          kind: "createdBy",
          actorThreadId,
          targetThreadId: result.thread.threadId,
        },
      },
    });

    const rootResult = yield* service.createRootThread({
      prompt: "Investigate the production alert.",
      target: { projectId, environment: { type: "worktree" } },
      modelSelection: actorModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
    });

    expect(rootResult.promptSubmitted).toBe(true);
    expect(dispatched.slice(3).map((command) => command.type)).toEqual([
      "thread.create",
      "thread.turn.start",
    ]);
    expect(dispatched[3]).toMatchObject({
      type: "thread.create",
      threadId: rootResult.thread.threadId,
      projectId,
      modelSelection: actorModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      worktreePath: "/repo/project-worktree",
      workspaceId,
    });
    expect(dispatched[4]).toMatchObject({
      type: "thread.turn.start",
      threadId: rootResult.thread.threadId,
      message: { text: "Investigate the production alert." },
    });
  }).pipe(Effect.provide(testLayer));
});

it.effect("resolves actor defaults before routing remote thread creation", () => {
  const remoteEnvironmentId = EnvironmentId.make("environment-remote");
  const remoteProjectId = "remote-project" as OrchestrationProject["id"];
  const dispatched: OrchestrationCommand[] = [];
  const remoteInputs: Parameters<RemoteThreadOrchestrationClient["Service"]["createThread"]>[1][] =
    [];
  const remoteScopes: Parameters<RemoteThreadOrchestrationClient["Service"]["createThread"]>[0][] =
    [];
  const remoteClientLayer = Layer.succeed(RemoteThreadOrchestrationClient, {
    listProjects: () => Effect.succeed({ environments: [] }),
    listThreadModels: () => Effect.succeed({ models: [] }),
    listThreads: () => Effect.die("unused remote listThreads"),
    readThread: () => Effect.die("unused remote readThread"),
    readThreadResult: () => Effect.die("unused remote readThreadResult"),
    getThreadGraph: () => Effect.die("unused remote getThreadGraph"),
    createThread: (remoteScope, input) =>
      Effect.sync(() => {
        remoteScopes.push(remoteScope);
        remoteInputs.push(input);
        return {
          thread: {
            environmentId: remoteEnvironmentId,
            threadId: ThreadId.make("remote-thread"),
            projectId: remoteProjectId,
            title: input.title ?? "Remote Reviewer",
            projectTitle: "Remote Project",
            status: "running" as const,
            modelSelection: input.modelSelection ?? projectDefaultModelSelection,
            runtimeMode: input.runtimeMode ?? "full-access",
            interactionMode: input.interactionMode ?? "default",
            workspaceRoot: "/srv/project",
            worktreePath: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          promptSubmitted: true,
        };
      }),
    createRootThread: () => Effect.die("unused remote createRootThread"),
    sendMessageToThread: () => Effect.die("unused remote sendMessageToThread"),
    setThreadTitle: () => Effect.die("unused remote setThreadTitle"),
  });
  const testLayer = ThreadOrchestrationServiceLive.pipe(
    Layer.provide(unsupportedCodexForkImporterLayer),
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        resolveReceipt: () => Effect.succeed(Option.none()),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
        latestSequence: Effect.succeed(0),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed(readModel),
        getSnapshot: () => Effect.die("full snapshot should not be read"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
        getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 2 }),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: getProjectShellById(),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: getThreadShellById(),
        getThreadResultContextById: getThreadResultContextById(),
        listThreadRelationshipActivities: listThreadRelationshipActivities(),
        getThreadDetailById: getThreadDetailById(),
        getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
        getTurnActivitiesSnapshot: () => Effect.succeed(Option.none()),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
    ),
    Layer.provide(
      Layer.succeed(ThreadWorkspaceService.ThreadWorkspaceService, {
        prepareWorkspace: () => Effect.die("unused"),
        resolvePrimaryCwd: () => Effect.succeed(undefined as string | undefined),
        deleteWorkspace: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(makeTestThreadDiscoveryDependencies(remoteClientLayer)),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadOrchestrationService;
    const result = yield* service.createThread(scope, {
      prompt: "Please review the remote implementation.",
      target: {
        environmentId: remoteEnvironmentId,
        projectId: remoteProjectId,
      },
      title: "Remote Reviewer",
    });

    expect(result.thread.environmentId).toBe(remoteEnvironmentId);
    expect(remoteScopes).toEqual([
      {
        environmentId: scope.environmentId,
        threadId: scope.threadId,
        providerSessionId: scope.providerSessionId,
        providerInstanceId: scope.providerInstanceId,
      },
    ]);
    expect(remoteInputs).toEqual([
      {
        prompt: "Please review the remote implementation.",
        target: {
          environmentId: remoteEnvironmentId,
          projectId: remoteProjectId,
        },
        title: "Remote Reviewer",
        modelSelection: actorModelSelection,
        runtimeMode: actorRuntimeMode,
        interactionMode: actorInteractionMode,
      },
    ]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "thread.activity.append",
      threadId: scope.threadId,
      activity: {
        kind: "thread-orchestration.relationship",
        payload: {
          kind: "createdBy",
          actorThreadId: scope.threadId,
          targetEnvironmentId: remoteEnvironmentId,
          targetThreadId: result.thread.threadId,
        },
      },
    });
  }).pipe(Effect.provide(testLayer));
});

it.effect("prepares requested worktrees for forked threads", () => {
  const dispatched: OrchestrationCommand[] = [];
  const preparedInputs: Parameters<
    ThreadWorkspaceService.ThreadWorkspaceService["Service"]["prepareWorkspace"]
  >[0][] = [];
  const testLayer = ThreadOrchestrationServiceLive.pipe(
    Layer.provide(unsupportedCodexForkImporterLayer),
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        resolveReceipt: () => Effect.succeed(Option.none()),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
        latestSequence: Effect.succeed(0),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed(readModel),
        getSnapshot: () => Effect.die("full snapshot should not be read"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
        getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 2 }),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: getProjectShellById(),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: getThreadShellById(),
        getThreadResultContextById: getThreadResultContextById(),
        listThreadRelationshipActivities: listThreadRelationshipActivities(),
        getThreadCoordinationShell: () =>
          Effect.succeed({
            relationships: [],
            efforts: [
              {
                effortId: forkEffortId,
                coordinator: {
                  environmentId: scope.environmentId,
                  threadId: scope.threadId,
                },
                title: "Fork implementation",
                members: [],
                openedAt: "2026-01-01T00:00:00.000Z",
                closedAt: null,
              },
            ],
            waits: [],
            watches: [],
          }),
        getThreadDetailById: getThreadDetailById(),
        getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
        getTurnActivitiesSnapshot: () => Effect.succeed(Option.none()),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
    ),
    Layer.provide(
      Layer.succeed(ThreadWorkspaceService.ThreadWorkspaceService, {
        prepareWorkspace: (input) =>
          Effect.sync(() => {
            preparedInputs.push(input);
            return {
              workspace: {
                id: workspaceId,
                kind: "jj-workspace",
                lifecycle: "active",
                displayName: "Fork of Target",
                managed: true,
                primaryRootId: workspaceRootId,
                roots: [],
                createdForThreadId: input.threadId,
                retentionPolicy: "explicit-delete",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                deletedAt: null,
                failureDetail: null,
                metadata: {},
              },
              primaryCwd: "/repo/project-worktree",
              compatibilityWorktreePath: "/repo/project-worktree",
              compatibilityBranch: "feature/fork",
            };
          }),
        resolvePrimaryCwd: () => Effect.succeed(undefined as string | undefined),
        deleteWorkspace: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(testThreadDiscoveryDependencies),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadOrchestrationService;
    const result = yield* service.forkThread(scope, {
      threadId: targetThreadId,
      environment: { type: "worktree" },
      coordination: { excludeInheritedEffort: true },
    });

    expect(preparedInputs).toMatchObject([
      {
        kind: "auto",
        roots: [{ projectId, sourcePath: "/repo/project", role: "primary" }],
        displayNameSeed: "Target",
        retentionPolicy: "explicit-delete",
      },
    ]);
    expect(result.thread.worktreePath).toBe("/repo/project-worktree");
    expect(result.transcriptCloned).toBe(false);
    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.activity.append",
      "thread.activity.append",
    ]);
    expect(dispatched[0]).toMatchObject({
      type: "thread.create",
      projectId,
      title: "Fork of Target",
      branch: "feature/fork",
      worktreePath: "/repo/project-worktree",
      workspaceId,
    });
    expect(dispatched[1]).toMatchObject({
      type: "thread.activity.append",
      threadId: result.thread.threadId,
      activity: {
        kind: "thread-orchestration.relationship",
        payload: {
          kind: "createdBy",
          actorThreadId,
          targetThreadId: result.thread.threadId,
        },
      },
    });
    expect(dispatched[2]).toMatchObject({
      type: "thread.activity.append",
      threadId: result.thread.threadId,
      activity: {
        kind: "thread-orchestration.relationship",
        payload: {
          kind: "forkedFrom",
          actorThreadId: targetThreadId,
          targetThreadId: result.thread.threadId,
        },
      },
    });

    const selfFork = yield* service.forkThread(scope, {
      coordination: { excludeInheritedEffort: true },
    });
    expect(dispatched.slice(3, 6)).toMatchObject([
      { type: "thread.create", threadId: selfFork.thread.threadId },
      {
        type: "thread.activity.append",
        activity: { payload: { kind: "createdBy", actorThreadId } },
      },
      {
        type: "thread.activity.append",
        activity: { payload: { kind: "forkedFrom", actorThreadId } },
      },
    ]);

    const effortFork = yield* service.forkThread(scope, {
      threadId: targetThreadId,
      coordination: { effortId: forkEffortId, label: "Prototype" },
    });
    expect(effortFork.membership).toMatchObject({
      effortId: forkEffortId,
      thread: { environmentId: scope.environmentId, threadId: effortFork.thread.threadId },
      label: "Prototype",
    });
    expect(dispatched.slice(6).map((command) => command.type)).toEqual([
      "thread.create",
      "thread.activity.append",
      "thread.activity.append",
    ]);
    expect(dispatched.at(-2)).toMatchObject({
      type: "thread.activity.append",
      threadId: effortFork.thread.threadId,
      activity: {
        kind: "thread-orchestration.relationship",
        payload: {
          kind: "createdBy",
          effortId: forkEffortId,
          label: "Prototype",
          actorThreadId,
          targetThreadId: effortFork.thread.threadId,
        },
      },
    });
  }).pipe(Effect.provide(testLayer));
});

it.effect("rejects fork requests while the source thread is running", () => {
  const runningReadModel: OrchestrationReadModel = {
    ...readModel,
    threads: readModel.threads.map((thread) =>
      thread.id === targetThreadId
        ? {
            ...thread,
            session: {
              threadId: thread.id,
              status: "running",
              providerName: "Codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
              runtimeMode: thread.runtimeMode,
              activeTurnId: null,
              lastError: null,
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          }
        : thread,
    ),
  };
  const testLayer = ThreadOrchestrationServiceLive.pipe(
    Layer.provide(
      Layer.succeed(CodexThreadForkImporter, {
        fork: () => Effect.die("fork importer should not be called for a running source thread"),
      }),
    ),
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        resolveReceipt: () => Effect.succeed(Option.none()),
        dispatch: () => Effect.die("dispatch should not be called for a running source thread"),
        latestSequence: Effect.succeed(0),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed(runningReadModel),
        getSnapshot: () => Effect.die("full snapshot should not be read"),
        getShellSnapshot: () => Effect.succeed(shellSnapshot),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
        getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 2 }),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: getProjectShellById(runningReadModel),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: getThreadShellById(runningReadModel),
        getThreadResultContextById: getThreadResultContextById(runningReadModel),
        listThreadRelationshipActivities: listThreadRelationshipActivities(runningReadModel),
        getThreadDetailById: getThreadDetailById(runningReadModel),
        getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
        getTurnActivitiesSnapshot: () => Effect.succeed(Option.none()),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
    ),
    Layer.provide(
      Layer.succeed(ThreadWorkspaceService.ThreadWorkspaceService, {
        prepareWorkspace: () =>
          Effect.die("workspace preparation should not be called for a running source thread"),
        resolvePrimaryCwd: () => Effect.succeed(undefined as string | undefined),
        deleteWorkspace: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(testThreadDiscoveryDependencies),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadOrchestrationService;
    const error = yield* service
      .forkThread(scope, {
        threadId: targetThreadId,
        environment: { type: "worktree" },
      })
      .pipe(Effect.flip);

    expect(error).toMatchObject({
      operation: "fork_thread",
      code: "source_busy",
      threadId: targetThreadId,
      projectId,
    });
  }).pipe(Effect.provide(testLayer));
});

it.effect("cleans up prepared workspaces when fallback fork dispatch fails", () => {
  const deletedWorkspaceIds: ThreadWorkspaceId[] = [];
  const testLayer = ThreadOrchestrationServiceLive.pipe(
    Layer.provide(unsupportedCodexForkImporterLayer),
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        resolveReceipt: () => Effect.succeed(Option.none()),
        dispatch: () =>
          Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: "thread.create",
              detail: "Dispatch failed.",
            }),
          ),
        latestSequence: Effect.succeed(0),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed(readModel),
        getSnapshot: () => Effect.die("full snapshot should not be read"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
        getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 2 }),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: getProjectShellById(),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: getThreadShellById(),
        getThreadResultContextById: getThreadResultContextById(),
        listThreadRelationshipActivities: listThreadRelationshipActivities(),
        getThreadDetailById: getThreadDetailById(),
        getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
        getTurnActivitiesSnapshot: () => Effect.succeed(Option.none()),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
    ),
    Layer.provide(
      Layer.succeed(ThreadWorkspaceService.ThreadWorkspaceService, {
        prepareWorkspace: (input) =>
          Effect.succeed({
            workspace: {
              id: workspaceId,
              kind: "jj-workspace",
              lifecycle: "active",
              displayName: "Fork of Target",
              managed: true,
              primaryRootId: workspaceRootId,
              roots: [],
              createdForThreadId: input.threadId,
              retentionPolicy: "explicit-delete",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              deletedAt: null,
              failureDetail: null,
              metadata: {},
            },
            primaryCwd: "/repo/project-worktree",
            compatibilityWorktreePath: "/repo/project-worktree",
            compatibilityBranch: "feature/fork",
          }),
        resolvePrimaryCwd: () => Effect.succeed(undefined as string | undefined),
        deleteWorkspace: (input) =>
          Effect.sync(() => {
            deletedWorkspaceIds.push(input.workspaceId);
          }),
      }),
    ),
    Layer.provide(testThreadDiscoveryDependencies),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadOrchestrationService;
    const error = yield* service
      .forkThread(scope, {
        threadId: targetThreadId,
        environment: { type: "worktree" },
      })
      .pipe(Effect.flip);

    expect(error).toMatchObject({ operation: "fork_thread.dispatch" });
    expect(deletedWorkspaceIds).toEqual([workspaceId]);
  }).pipe(Effect.provide(testLayer));
});

it.effect("uses Codex App Server fork imports for Codex-backed threads", () => {
  const dispatched: OrchestrationCommand[] = [];
  const importerInputs: Parameters<CodexThreadForkImporter["Service"]["fork"]>[0][] = [];
  const codexForkImporterLayer = Layer.succeed(CodexThreadForkImporter, {
    fork: (input) =>
      Effect.sync(() => {
        importerInputs.push(input);
        return {
          thread: {
            environmentId: scope.environmentId,
            threadId: input.threadId,
            projectId: input.project.id,
            title: input.title,
            projectTitle: input.project.title,
            status: "idle" as const,
            modelSelection: input.sourceThread.modelSelection,
            runtimeMode: input.sourceThread.runtimeMode,
            interactionMode: input.sourceThread.interactionMode,
            workspaceRoot: input.project.workspaceRoot,
            worktreePath: input.sourceThread.worktreePath,
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
          },
          sourceProviderThreadId: "provider-source-thread",
          providerThreadId: "provider-fork-thread",
          importedMessageCount: 2,
        };
      }),
  });
  const testLayer = ThreadOrchestrationServiceLive.pipe(
    Layer.provide(codexForkImporterLayer),
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        resolveReceipt: () => Effect.succeed(Option.none()),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
        latestSequence: Effect.succeed(0),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed(readModel),
        getSnapshot: () => Effect.die("full snapshot should not be read"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
        getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 2 }),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: getProjectShellById(),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: getThreadShellById(),
        getThreadResultContextById: getThreadResultContextById(),
        listThreadRelationshipActivities: listThreadRelationshipActivities(),
        getThreadDetailById: getThreadDetailById(),
        getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
        getTurnActivitiesSnapshot: () => Effect.succeed(Option.none()),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
    ),
    Layer.provide(
      Layer.succeed(ThreadWorkspaceService.ThreadWorkspaceService, {
        prepareWorkspace: () => Effect.die("unused"),
        resolvePrimaryCwd: () => Effect.succeed(undefined as string | undefined),
        deleteWorkspace: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(testThreadDiscoveryDependencies),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadOrchestrationService;
    const result = yield* service.forkThread(scope, {
      threadId: targetThreadId,
    });

    expect(importerInputs).toMatchObject([
      {
        sourceThread: { id: targetThreadId },
        project: { id: projectId },
        title: "Fork of Target",
      },
    ]);
    expect(result.transcriptCloned).toBe(true);
    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.activity.append",
      "thread.activity.append",
    ]);
    expect(dispatched[0]).toMatchObject({
      type: "thread.activity.append",
      threadId: result.thread.threadId,
      activity: {
        kind: "thread-orchestration.relationship",
        payload: {
          kind: "createdBy",
          actorThreadId,
          targetThreadId: result.thread.threadId,
        },
      },
    });
    expect(dispatched[1]).toMatchObject({
      type: "thread.activity.append",
      threadId: result.thread.threadId,
      activity: {
        kind: "thread-orchestration.relationship",
        payload: {
          kind: "forkedFrom",
          actorThreadId: targetThreadId,
          targetThreadId: result.thread.threadId,
        },
      },
    });
  }).pipe(Effect.provide(testLayer));
});

it.effect("cleans up prepared workspaces when Codex-backed forks fail", () => {
  const dispatched: OrchestrationCommand[] = [];
  const deletedWorkspaceIds: ThreadWorkspaceId[] = [];
  const codexForkImporterLayer = Layer.succeed(CodexThreadForkImporter, {
    fork: () =>
      Effect.fail(
        new ThreadOrchestrationError({
          operation: "fork_thread.codex_fork",
          code: "operation_failed",
          message: "Codex App Server fork failed.",
          threadId: targetThreadId,
          projectId,
        }),
      ),
  });
  const testLayer = ThreadOrchestrationServiceLive.pipe(
    Layer.provide(codexForkImporterLayer),
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        resolveReceipt: () => Effect.succeed(Option.none()),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
        latestSequence: Effect.succeed(0),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed(readModel),
        getSnapshot: () => Effect.die("full snapshot should not be read"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
        getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 2 }),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: getProjectShellById(),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: getThreadShellById(),
        getThreadResultContextById: getThreadResultContextById(),
        listThreadRelationshipActivities: listThreadRelationshipActivities(),
        getThreadDetailById: getThreadDetailById(),
        getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
        getTurnActivitiesSnapshot: () => Effect.succeed(Option.none()),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
    ),
    Layer.provide(
      Layer.succeed(ThreadWorkspaceService.ThreadWorkspaceService, {
        prepareWorkspace: (input) =>
          Effect.succeed({
            workspace: {
              id: workspaceId,
              kind: "jj-workspace",
              lifecycle: "active",
              displayName: "Fork of Target",
              managed: true,
              primaryRootId: workspaceRootId,
              roots: [],
              createdForThreadId: input.threadId,
              retentionPolicy: "explicit-delete",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              deletedAt: null,
              failureDetail: null,
              metadata: {},
            },
            primaryCwd: "/repo/project-worktree",
            compatibilityWorktreePath: "/repo/project-worktree",
            compatibilityBranch: "feature/fork",
          }),
        resolvePrimaryCwd: () => Effect.succeed(undefined as string | undefined),
        deleteWorkspace: (input) =>
          Effect.sync(() => {
            deletedWorkspaceIds.push(input.workspaceId);
          }),
      }),
    ),
    Layer.provide(testThreadDiscoveryDependencies),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadOrchestrationService;
    const error = yield* service
      .forkThread(scope, {
        threadId: targetThreadId,
        environment: { type: "worktree" },
      })
      .pipe(Effect.flip);

    expect(error).toMatchObject({ operation: "fork_thread.codex_fork" });
    expect(deletedWorkspaceIds).toEqual([workspaceId]);
    expect(dispatched).toEqual([]);
  }).pipe(Effect.provide(testLayer));
});

it.effect("returns provider availability failures in compact coordinator results", () => {
  const dispatched: OrchestrationCommand[] = [];
  const providerUnavailable = {
    type: "provider_unavailable" as const,
    cause: "rate_limited" as const,
    scope: "provider_instance" as const,
    provider: ProviderDriverKind.make("opencode"),
    providerInstanceId: ProviderInstanceId.make("opencode"),
    model: "zai-coding-plan/glm-5.3-flash",
    reason: "Usage limit reached for 5 hour.",
    retryable: true,
    retryAt: "2026-09-03T10:43:23.775Z",
  };
  const assistantMessage = {
    id: "message-assistant" as OrchestrationThread["messages"][number]["id"],
    role: "assistant" as const,
    text: "The review is complete.",
    turnId: null,
    streaming: false,
    createdAt: "2026-01-01T00:01:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
  };
  const model: OrchestrationReadModel = {
    ...readModel,
    threads: [
      makeThread(actorThreadId),
      {
        ...makeThread(targetThreadId),
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "zai-coding-plan/glm-5.3-flash",
        },
        session: {
          threadId: targetThreadId,
          status: "error",
          providerName: "opencode",
          providerInstanceId: ProviderInstanceId.make("opencode"),
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: providerUnavailable.reason,
          lastErrorClass: "rate_limited",
          providerUnavailable,
          updatedAt: "2026-09-03T08:35:33.748Z",
        },
        messages: [
          {
            id: "message-user" as OrchestrationThread["messages"][number]["id"],
            role: "user",
            text: "Please review.",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          assistantMessage,
        ],
      },
    ],
  };
  const testLayer = ThreadOrchestrationServiceLive.pipe(
    Layer.provide(unsupportedCodexForkImporterLayer),
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        resolveReceipt: () => Effect.succeed(Option.none()),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
        latestSequence: Effect.succeed(0),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed(model),
        getSnapshot: () => Effect.die("full snapshot should not be read"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
        getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 2 }),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: getProjectShellById(model),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: getThreadShellById(model),
        getThreadResultContextById: getThreadResultContextById(model),
        listThreadRelationshipActivities: listThreadRelationshipActivities(model),
        getThreadDetailById: getThreadDetailById(model),
        getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
        getTurnActivitiesSnapshot: () => Effect.succeed(Option.none()),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
    ),
    Layer.provide(
      Layer.succeed(ThreadWorkspaceService.ThreadWorkspaceService, {
        prepareWorkspace: () => Effect.die("unused"),
        resolvePrimaryCwd: () => Effect.succeed(undefined as string | undefined),
        deleteWorkspace: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(testThreadDiscoveryDependencies),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadOrchestrationService;
    const detail = yield* service.readThread(
      { ...scope, threadId: targetThreadId },
      { threadId: targetThreadId, turnLimit: 1 },
    );
    const result = yield* service.readThreadResult(scope, {
      threadId: targetThreadId,
    });

    expect(detail.messages).toEqual(model.threads[1]?.messages);
    expect(result.thread.threadId).toBe(targetThreadId);
    expect(result.latestAssistantMessage).toEqual(assistantMessage);
    expect(result.queuedMessageCount).toBe(0);
    expect(result.failure).toEqual(providerUnavailable);
    expect(dispatched).toEqual([]);
  }).pipe(Effect.provide(testLayer));
});

it.effect("reads relationship graphs without adding read edges", () => {
  const dispatched: OrchestrationCommand[] = [];
  const createdAt = "2026-01-01T00:02:00.000Z";
  const model: OrchestrationReadModel = {
    ...readModel,
    threads: [
      makeThread(actorThreadId),
      {
        ...makeThread(targetThreadId),
        activities: [
          {
            id: "activity-message" as OrchestrationThread["activities"][number]["id"],
            tone: "tool",
            kind: "thread-orchestration.relationship",
            summary: "Messaged by actor.",
            payload: {
              kind: "messagedBy",
              actorThreadId,
              targetThreadId,
              createdAt,
            },
            turnId: null,
            createdAt,
          },
          {
            id: "activity-read" as OrchestrationThread["activities"][number]["id"],
            tone: "tool",
            kind: "thread-orchestration.relationship",
            summary: "Read by actor.",
            payload: {
              kind: "readBy",
              actorThreadId,
              targetThreadId,
              createdAt,
            },
            turnId: null,
            createdAt,
          },
        ],
      },
    ],
  };
  const testLayer = ThreadOrchestrationServiceLive.pipe(
    Layer.provide(unsupportedCodexForkImporterLayer),
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        resolveReceipt: () => Effect.succeed(Option.none()),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
        latestSequence: Effect.succeed(0),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed(model),
        getSnapshot: () => Effect.die("full snapshot should not be read"),
        getShellSnapshot: () => Effect.succeed(makeShellSnapshot(model, false)),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
        getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 2 }),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: getProjectShellById(model),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: getThreadShellById(model),
        getThreadResultContextById: getThreadResultContextById(),
        listThreadRelationshipActivities: listThreadRelationshipActivities(model),
        getThreadDetailById: getThreadDetailById(model),
        getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
        getTurnActivitiesSnapshot: () => Effect.succeed(Option.none()),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
    ),
    Layer.provide(
      Layer.succeed(ThreadWorkspaceService.ThreadWorkspaceService, {
        prepareWorkspace: () => Effect.die("unused"),
        resolvePrimaryCwd: () => Effect.succeed(undefined as string | undefined),
        deleteWorkspace: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(testThreadDiscoveryDependencies),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadOrchestrationService;
    const graph = yield* service.getThreadGraph(scope, {
      rootThreadId: actorThreadId,
      depth: 1,
    });

    expect(graph.nodes.map((node) => node.threadId).toSorted()).toEqual(
      [actorThreadId, targetThreadId].toSorted(),
    );
    expect(graph.edges).toEqual([
      {
        kind: "messagedBy",
        actorThreadId,
        targetThreadId,
        createdAt,
      },
    ]);
    expect(dispatched).toEqual([]);
  }).pipe(Effect.provide(testLayer));
});
