import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  ThreadOrchestrationError,
  ThreadWorkspaceId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { CodexThreadForkImporter } from "../mcp/toolkits/thread-orchestration/CodexThreadForkImporter.ts";
import type { ThreadManagementServiceShape } from "../orchestration-v2/ThreadManagementService.ts";
import type * as ServerSettings from "../serverSettings.ts";
import type * as ThreadWorkspaceService from "../workspace/ThreadWorkspaceService.ts";
import type * as ProviderRegistry from "./Services/ProviderRegistry.ts";
import { makeCodexThreadRpcWorkflow } from "./CodexThreadRpcWorkflow.ts";

const provider = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");
const sourceThreadId = ThreadId.make("thread-source");
const destinationThreadId = ThreadId.make("thread-destination");
const projectId = ProjectId.make("project-1");
const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.succeed(data),
});
const testSpawner = ChildProcessSpawner.make(() => Effect.die("unexpected provider process"));

const baseProviderRegistry = {
  getProviders: Effect.succeed([]),
} as unknown as ProviderRegistry.ProviderRegistryShape;
const baseSettings = {
  getSettings: Effect.die("unexpected settings read"),
} as unknown as ServerSettings.ServerSettingsService["Service"];
const baseWorkspace = {
  prepareWorkspace: () => Effect.die("unexpected workspace preparation"),
  deleteWorkspace: () => Effect.die("unexpected workspace deletion"),
} as unknown as ThreadWorkspaceService.ThreadWorkspaceService["Service"];
const baseImporter = {
  fork: () => Effect.die("unexpected fork import"),
} as unknown as CodexThreadForkImporter["Service"];

const makeThread = (): OrchestrationV2AppThread =>
  ({
    id: sourceThreadId,
    projectId,
    title: "Source",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: "/repo/project",
    activeProviderThreadId: ProviderThreadId.make("provider-thread-source"),
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: sourceThreadId },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  }) as OrchestrationV2AppThread;

const makeProviderThread = (): OrchestrationV2ProviderThread =>
  ({
    id: ProviderThreadId.make("provider-thread-source"),
    driver: provider,
    providerInstanceId,
    providerSessionId: null,
    appThreadId: sourceThreadId,
    ownerNodeId: null,
    nativeThreadRef: { driver: provider, nativeId: "native-source", strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    createdAt: now,
    updatedAt: now,
  }) as OrchestrationV2ProviderThread;

const makeProjection = (busy = false): OrchestrationV2ThreadProjection =>
  ({
    thread: makeThread(),
    runs: busy ? [{ status: "running" }] : [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [makeProviderThread()],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: now,
  }) as unknown as OrchestrationV2ThreadProjection;

const makeWorkflow = (overrides: {
  readonly threadManagement?: ThreadManagementServiceShape;
  readonly providerRegistry?: ProviderRegistry.ProviderRegistryShape;
  readonly threadWorkspaceService?: ThreadWorkspaceService.ThreadWorkspaceService["Service"];
  readonly codexThreadForkImporter?: CodexThreadForkImporter["Service"];
}) =>
  makeCodexThreadRpcWorkflow({
    configCwd: "/repo",
    threadManagement:
      overrides.threadManagement ??
      ({
        getThreadProjection: () => Effect.die("unexpected projection read"),
        dispatch: () => Effect.succeed({ sequence: 1, storedEvents: [] }),
      } as unknown as ThreadManagementServiceShape),
    providerRegistry: overrides.providerRegistry ?? baseProviderRegistry,
    serverSettings: baseSettings,
    threadWorkspaceService: overrides.threadWorkspaceService ?? baseWorkspace,
    codexThreadForkImporter: overrides.codexThreadForkImporter ?? baseImporter,
    childProcessSpawner: testSpawner,
  }).pipe(Effect.provideService(Crypto.Crypto, testCrypto), Effect.provide(NodeServices.layer));

it.layer(NodeServices.layer)("CodexThreadRpcWorkflow", (it) => {
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
      const error = yield* Effect.flip(workflow.resume({ threadId: "   " }));
      expect(error.message).toBe("Codex thread id is required.");
      expect(providerReads).toBe(0);
    }),
  );

  it.effect("rejects a busy V2 thread before importing", () =>
    Effect.gen(function* () {
      let imports = 0;
      const workflow = yield* makeWorkflow({
        threadManagement: {
          getThreadProjection: () => Effect.succeed(makeProjection(true)),
          dispatch: () => Effect.succeed({ sequence: 1, storedEvents: [] }),
        } as unknown as ThreadManagementServiceShape,
        codexThreadForkImporter: {
          fork: () =>
            Effect.sync(() => {
              imports += 1;
              return undefined;
            }).pipe(Effect.die),
        } as unknown as CodexThreadForkImporter["Service"],
      });
      const error = yield* Effect.flip(workflow.fork({ threadId: sourceThreadId }));
      expect(error.message).toBe("Cannot fork a thread while its latest turn is still running.");
      expect(imports).toBe(0);
    }),
  );

  it.effect("cleans up a prepared workspace when native import fails", () =>
    Effect.gen(function* () {
      const workspaceId = ThreadWorkspaceId.make("workspace-fork");
      const deleted: Array<unknown> = [];
      const workflow = yield* makeWorkflow({
        threadManagement: {
          getThreadProjection: () => Effect.succeed(makeProjection()),
          dispatch: () => Effect.succeed({ sequence: 1, storedEvents: [] }),
        } as unknown as ThreadManagementServiceShape,
        threadWorkspaceService: {
          prepareWorkspace: (request: { readonly threadId: ThreadId }) =>
            Effect.succeed({
              workspace: {
                id: workspaceId,
                kind: "directory-copy",
                lifecycle: "active",
                displayName: "Fork",
                managed: true,
                primaryRootId: "root",
                roots: [],
                createdForThreadId: request.threadId,
                retentionPolicy: "explicit-delete",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                deletedAt: null,
                failureDetail: null,
                metadata: {},
              },
              primaryCwd: "/repo/fork",
              compatibilityWorktreePath: "/repo/fork",
              compatibilityBranch: null,
            } as never),
          deleteWorkspace: (request: {
            readonly workspaceId: ThreadWorkspaceId;
            readonly force?: boolean;
          }) => Effect.sync(() => void deleted.push(request)),
        } as unknown as ThreadWorkspaceService.ThreadWorkspaceService["Service"],
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
        } as unknown as CodexThreadForkImporter["Service"],
      });
      const error = yield* Effect.flip(
        workflow.fork({
          threadId: sourceThreadId,
          workspace: { mode: "new", kind: "directory-copy" },
        }),
      );
      expect(error.message).toBe("import failed");
      expect(deleted).toHaveLength(1);
    }),
  );

  it.effect("returns a fork even when relationship activity recording fails", () =>
    Effect.gen(function* () {
      const workflow = yield* makeWorkflow({
        threadManagement: {
          getThreadProjection: () => Effect.succeed(makeProjection()),
          dispatch: () =>
            Effect.fail(
              new ThreadOrchestrationError({
                operation: "thread.activity.append",
                code: "operation_failed",
                message: "activity failed",
                threadId: sourceThreadId,
                projectId,
              }),
            ),
        } as unknown as ThreadManagementServiceShape,
        codexThreadForkImporter: {
          fork: () =>
            Effect.succeed({
              threadId: destinationThreadId,
              providerThreadId: ProviderThreadId.make("provider-thread-destination"),
              sourceProviderThreadId: ProviderThreadId.make("provider-thread-source"),
              importedMessageCount: 4,
              projection: makeProjection(),
            }),
        } as unknown as CodexThreadForkImporter["Service"],
      });
      const result = yield* workflow.fork({ threadId: sourceThreadId });
      expect(result).toMatchObject({
        threadId: destinationThreadId,
        projectId,
        sourceThreadId,
        importedMessageCount: 4,
        workspaceId: null,
      });
    }),
  );
});
