import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  ThreadOrchestrationError,
  ThreadWorkspaceId,
  ThreadWorkspaceRootId,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ThreadOrchestrationThreadSummary,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { CodexThreadForkImporter } from "../mcp/toolkits/thread-orchestration/CodexThreadForkImporter.ts";
import type * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import type * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type * as ServerSettings from "../serverSettings.ts";
import type * as ThreadWorkspaceService from "../workspace/ThreadWorkspaceService.ts";
import type * as ProviderRegistry from "./Services/ProviderRegistry.ts";
import type * as ProviderSessionDirectory from "./Services/ProviderSessionDirectory.ts";
import { makeProviderRegistryMock } from "./testUtils/providerRegistryMock.ts";
import { makeCodexThreadRpcWorkflow } from "./CodexThreadRpcWorkflow.ts";

const projectId = ProjectId.make("project-1");
const sourceThreadId = ThreadId.make("thread-source");
const destinationThreadId = ThreadId.make("thread-destination");
const provider = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");
const now = "2026-01-01T00:00:00.000Z";

const project: OrchestrationProject = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo/project",
  defaultModelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
  scripts: [],
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
};

const makeThread = (overrides: Partial<OrchestrationThread> = {}): OrchestrationThread => ({
  id: sourceThreadId,
  projectId,
  title: "Source",
  modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  workspaceId: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
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
  ...overrides,
});

const readModel = (thread: OrchestrationThread): OrchestrationReadModel => ({
  snapshotSequence: 1,
  projects: [project],
  threads: [thread],
  usageLimits: [],
  updatedAt: now,
});

const baseProjectionQuery = {
  getCommandReadModel: () => Effect.die("unexpected command read"),
  getThreadRuntimeContext: () => Effect.die("unexpected runtime context read"),
  getSnapshot: () => Effect.die("unexpected snapshot read"),
  getShellSnapshot: () => Effect.die("unexpected shell snapshot read"),
  getArchivedShellSnapshot: () => Effect.die("unexpected archived snapshot read"),
  getSnapshotSequence: () => Effect.die("unexpected sequence read"),
  getCounts: () => Effect.die("unexpected counts read"),
  getActiveProjectByWorkspaceRoot: () => Effect.die("unexpected project read"),
  getProjectShellById: () => Effect.die("unexpected project shell read"),
  getFirstActiveThreadIdByProjectId: () => Effect.die("unexpected first thread read"),
  getThreadCheckpointContext: () => Effect.die("unexpected checkpoint read"),
  getFullThreadDiffContext: () => Effect.die("unexpected diff read"),
  getThreadShellById: () => Effect.die("unexpected thread shell read"),
  getThreadResultContextById: () => Effect.die("unexpected result read"),
  listThreadRelationshipActivities: () => Effect.die("unused"),
  getThreadDetailById: () => Effect.die("unexpected thread detail read"),
  getThreadDetailSnapshot: () => Effect.die("unexpected detail snapshot read"),
  getTurnActivitiesSnapshot: () => Effect.die("unexpected activity read"),
  searchThreads: () => Effect.die("unexpected search"),
} satisfies ProjectionSnapshotQuery.ProjectionSnapshotQueryShape;

const baseEngine: OrchestrationEngine.OrchestrationEngineShape = {
  readEvents: () => Stream.empty,
  readThreadEvents: () => Stream.die("unexpected thread replay"),
  getThreadReplayStats: () => Effect.die("unexpected thread replay stats"),
  resolveReceipt: () => Effect.succeed(Option.none()),
  dispatch: () => Effect.die("unexpected dispatch"),
  latestSequence: Effect.succeed(0),
  streamDomainEvents: Stream.empty,
};

const baseProviderRegistry = makeProviderRegistryMock();

const baseProviderSessionDirectory: ProviderSessionDirectory.ProviderSessionDirectoryShape = {
  upsert: () => Effect.die("unexpected binding write"),
  getProvider: () => Effect.die("unexpected provider read"),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.die("unexpected thread list"),
  listBindings: () => Effect.die("unexpected binding list"),
};

const baseThreadWorkspaceService: ThreadWorkspaceService.ThreadWorkspaceService["Service"] = {
  prepareWorkspace: () => Effect.die("unexpected workspace preparation"),
  resolvePrimaryCwd: () => Effect.die("unexpected workspace resolution"),
  deleteWorkspace: () => Effect.die("unexpected workspace deletion"),
};

const baseForkImporter: CodexThreadForkImporter["Service"] = {
  fork: () => Effect.die("unexpected fork import"),
};

const baseServerSettings: ServerSettings.ServerSettingsService["Service"] = {
  start: Effect.void,
  ready: Effect.void,
  getSettings: Effect.die("unexpected settings read"),
  updateSettings: () => Effect.die("unexpected settings update"),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.succeed(Stream.empty),
};

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.succeed(data),
});
const testSpawner = ChildProcessSpawner.make(() => Effect.die("unexpected provider process"));

const makeWorkflow = (overrides: {
  readonly orchestrationEngine?: OrchestrationEngine.OrchestrationEngineShape;
  readonly projectionSnapshotQuery?: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape;
  readonly providerRegistry?: ProviderRegistry.ProviderRegistryShape;
  readonly providerSessionDirectory?: ProviderSessionDirectory.ProviderSessionDirectoryShape;
  readonly threadWorkspaceService?: ThreadWorkspaceService.ThreadWorkspaceService["Service"];
  readonly codexThreadForkImporter?: CodexThreadForkImporter["Service"];
}) =>
  makeCodexThreadRpcWorkflow({
    configCwd: "/repo",
    orchestrationEngine: overrides.orchestrationEngine ?? baseEngine,
    projectionSnapshotQuery: overrides.projectionSnapshotQuery ?? baseProjectionQuery,
    providerRegistry: overrides.providerRegistry ?? baseProviderRegistry,
    providerSessionDirectory: overrides.providerSessionDirectory ?? baseProviderSessionDirectory,
    serverSettings: baseServerSettings,
    threadWorkspaceService: overrides.threadWorkspaceService ?? baseThreadWorkspaceService,
    codexThreadForkImporter: overrides.codexThreadForkImporter ?? baseForkImporter,
    childProcessSpawner: testSpawner,
    dispatchNormalizedCommand: () => Effect.die("unexpected normalized dispatch"),
  }).pipe(Effect.provideService(Crypto.Crypto, testCrypto));

const codexBinding = {
  threadId: sourceThreadId,
  provider,
  providerInstanceId,
  resumeCursor: { threadId: "provider-thread-source" },
};

describe("CodexThreadRpcWorkflow", () => {
  it.effect("rejects an empty resume id before provider discovery", () =>
    Effect.gen(function* () {
      let providerReads = 0;
      const workflow = yield* makeWorkflow({
        providerRegistry: {
          ...baseProviderRegistry,
          getProviders: Effect.sync(() => {
            providerReads += 1;
            return [];
          }),
        },
      });
      const error = yield* Effect.flip(
        workflow.resume({ threadId: "   " }).pipe(Effect.provide(NodeServices.layer)),
      );
      expect(error.message).toBe("Codex thread id is required.");
      expect(providerReads).toBe(0);
    }),
  );

  it.effect("reports unavailable Codex providers without touching persistence", () =>
    Effect.gen(function* () {
      const workflow = yield* makeWorkflow({});
      const error = yield* Effect.flip(
        workflow.resume({ threadId: "provider-thread" }).pipe(Effect.provide(NodeServices.layer)),
      );
      expect(error.message).toBe("No enabled Codex provider instance is available.");
    }),
  );

  it.effect("rejects busy threads and invalid message fork points before importing", () =>
    Effect.gen(function* () {
      let imports = 0;
      const importer: CodexThreadForkImporter["Service"] = {
        fork: () =>
          Effect.sync(() => {
            imports += 1;
          }).pipe(Effect.andThen(Effect.die("unexpected fork import"))),
      };
      const directory = {
        ...baseProviderSessionDirectory,
        getBinding: () => Effect.succeed(Option.some(codexBinding)),
      };
      const runningThread = makeThread({
        latestTurn: {
          turnId: TurnId.make("turn-running"),
          state: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          assistantMessageId: null,
        },
      });
      const busyWorkflow = yield* makeWorkflow({
        providerSessionDirectory: directory,
        codexThreadForkImporter: importer,
        projectionSnapshotQuery: {
          ...baseProjectionQuery,
          getThreadDetailById: () => Effect.succeed(Option.some(runningThread)),
        },
      });
      const busyError = yield* Effect.flip(busyWorkflow.fork({ threadId: sourceThreadId }));
      expect(busyError.message).toBe(
        "Cannot fork a thread while its latest turn is still running.",
      );

      const userMessageId = MessageId.make("message-user");
      const idleThread = makeThread({
        messages: [
          {
            id: userMessageId,
            role: "user",
            text: "Question",
            attachments: [],
            turnId: null,
            createdAt: now,
            updatedAt: now,
            streaming: false,
          },
        ],
      });
      const invalidPointWorkflow = yield* makeWorkflow({
        providerSessionDirectory: directory,
        codexThreadForkImporter: importer,
        projectionSnapshotQuery: {
          ...baseProjectionQuery,
          getThreadDetailById: () => Effect.succeed(Option.some(idleThread)),
        },
      });
      const pointError = yield* Effect.flip(
        invalidPointWorkflow.fork({
          threadId: sourceThreadId,
          sourceMessageId: userMessageId,
        }),
      );
      expect(pointError.message).toBe("Only assistant messages can be used as Codex fork points.");
      expect(imports).toBe(0);
    }),
  );

  it.effect("deletes a prepared workspace when the importer fails", () =>
    Effect.gen(function* () {
      const workspaceId = ThreadWorkspaceId.make("workspace-fork");
      const deleted: Array<{ readonly workspaceId: ThreadWorkspaceId; readonly force?: boolean }> =
        [];
      const thread = makeThread();
      const workflow = yield* makeWorkflow({
        providerSessionDirectory: {
          ...baseProviderSessionDirectory,
          getBinding: () => Effect.succeed(Option.some(codexBinding)),
        },
        projectionSnapshotQuery: {
          ...baseProjectionQuery,
          getThreadDetailById: () => Effect.succeed(Option.some(thread)),
          getCommandReadModel: () => Effect.succeed(readModel(thread)),
        },
        threadWorkspaceService: {
          ...baseThreadWorkspaceService,
          prepareWorkspace: (input) =>
            Effect.succeed({
              workspace: {
                id: workspaceId,
                kind: "directory-copy",
                lifecycle: "active",
                displayName: "Fork of Source",
                managed: true,
                primaryRootId: ThreadWorkspaceRootId.make("workspace-root-fork"),
                roots: [],
                createdForThreadId: input.threadId,
                retentionPolicy: "explicit-delete",
                createdAt: now,
                updatedAt: now,
                deletedAt: null,
                failureDetail: null,
                metadata: {},
              },
              primaryCwd: "/repo/project-fork",
              compatibilityWorktreePath: "/repo/project-fork",
              compatibilityBranch: null,
            }),
          deleteWorkspace: (request) =>
            Effect.sync(() => {
              deleted.push(request);
            }),
        },
        codexThreadForkImporter: {
          fork: () =>
            Effect.fail(
              new ThreadOrchestrationError({
                operation: "fork_thread.codex",
                code: "operation_failed",
                message: "import failed",
                threadId: sourceThreadId,
                projectId,
              }),
            ),
        },
      });

      const error = yield* Effect.flip(
        workflow.fork({
          threadId: sourceThreadId,
          workspace: { mode: "new", kind: "directory-copy" },
        }),
      );
      expect(error.message).toBe("import failed");
      expect(deleted).toEqual([{ workspaceId, force: true }]);
    }),
  );

  it.effect("returns a successful fork when relationship activity recording fails", () =>
    Effect.gen(function* () {
      const thread = makeThread();
      const summary: ThreadOrchestrationThreadSummary = {
        environmentId: EnvironmentId.make("environment-1"),
        threadId: destinationThreadId,
        projectId,
        title: "Fork of Source",
        projectTitle: "Project",
        status: "idle",
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        workspaceRoot: project.workspaceRoot,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      };
      const workflow = yield* makeWorkflow({
        orchestrationEngine: {
          ...baseEngine,
          dispatch: () =>
            Effect.fail(
              new OrchestrationCommandInvariantError({
                commandType: "thread.activity.append",
                detail: "relationship activity failed",
              }),
            ),
        },
        providerSessionDirectory: {
          ...baseProviderSessionDirectory,
          getBinding: () => Effect.succeed(Option.some(codexBinding)),
        },
        projectionSnapshotQuery: {
          ...baseProjectionQuery,
          getThreadDetailById: () => Effect.succeed(Option.some(thread)),
          getCommandReadModel: () => Effect.succeed(readModel(thread)),
        },
        codexThreadForkImporter: {
          fork: () =>
            Effect.succeed({
              thread: summary,
              sourceProviderThreadId: "provider-thread-source",
              providerThreadId: "provider-thread-destination",
              importedMessageCount: 4,
            }),
        },
      });

      const result = yield* workflow.fork({ threadId: sourceThreadId });
      expect(result).toMatchObject({
        threadId: destinationThreadId,
        projectId,
        sourceThreadId,
        providerThreadId: "provider-thread-destination",
        importedMessageCount: 4,
        workspaceId: null,
      });
    }),
  );
});
