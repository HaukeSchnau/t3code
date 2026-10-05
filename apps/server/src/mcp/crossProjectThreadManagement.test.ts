import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as CrossProjectThreadManagement from "./crossProjectThreadManagement.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";
import { ThreadToolkitHandlersLive } from "./toolkits/thread/handlers.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";

const callerProjectId = ProjectId.make("project:cross-project-caller");
const otherProjectId = ProjectId.make("project:cross-project-other");
const callerThreadId = ThreadId.make("thread:cross-project-caller");
const otherThreadId = ThreadId.make("thread:cross-project-other");
const codex = ProviderInstanceId.make("codex");

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:cross-project"),
  threadId: callerThreadId,
  providerSessionId: "provider-session:cross-project",
  providerInstanceId: codex,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

// Dispatch reads capabilities; the effect worker that would open a session never runs.
const capabilitiesOnlyAdapters = Layer.succeed(
  ProviderAdapterRegistry.ProviderAdapterRegistryV2,
  ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
    get: (instanceId) =>
      Effect.succeed({
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: () => Effect.die("provider sessions are not opened in this test"),
      }),
    list: () => Effect.succeed([codex]),
  }),
);

const crossProjectLayer = CrossProjectThreadManagement.layer.pipe(
  Layer.provide(
    Layer.mock(ProjectService.ProjectService)({
      getById: (projectId) =>
        Effect.succeed(
          projectId === callerProjectId || projectId === otherProjectId
            ? Option.some({ id: projectId } as Project)
            : Option.none(),
        ),
    }),
  ),
);

// The MCP services see the decorated service, as in server.ts. The test body
// sees the undecorated one, like every non-MCP consumer.
const testLayer = Layer.mergeAll(OrchestratorMcpService.layer, ThreadMetadataMcpService.layer).pipe(
  Layer.provide(crossProjectLayer),
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
        list: () => Effect.succeed([]),
      }),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    ),
  ),
  Layer.provideMerge(
    ThreadManagementService.layer.pipe(
      Layer.provideMerge(
        makeOrchestratorV2ReplayLayerWithRegistry(
          { name: "cross-project-mcp" },
          capabilitiesOnlyAdapters,
          { runEffectWorker: false },
        ),
      ),
    ),
  ),
);

const createThread = (threadId: ThreadId, projectId: ProjectId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:create:${threadId}`),
      threadId,
      projectId,
      title: `Thread in ${projectId}`,
      modelSelection: { instanceId: codex, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
  });

const seedThreads = Effect.all([
  createThread(callerThreadId, callerProjectId),
  createThread(otherThreadId, otherProjectId),
]);

it.effect("reads, renames, sends to, interrupts, and waits for a thread in another project", () =>
  Effect.gen(function* () {
    yield* seedThreads;
    const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
    const metadata = yield* ThreadMetadataMcpService.ThreadMetadataMcpService;

    const read = yield* mcp.readThread(scope, { threadId: otherThreadId });
    expect(read.thread.projectId).toBe(otherProjectId);

    const renamed = yield* metadata.update(scope, {
      threadId: otherThreadId,
      action: "rename",
      title: "Renamed from another project",
    });
    expect(renamed.title).toBe("Renamed from another project");

    const sent = yield* mcp.sendToThread(scope, {
      threadId: otherThreadId,
      message: "Hello from another project",
    });
    expect(sent.delivery).toBe("started");

    const interrupted = yield* mcp.interruptThread(scope, { threadId: otherThreadId });
    expect(interrupted).toMatchObject({ runId: sent.runId, status: "interrupt_requested" });

    const waited = yield* mcp.waitForThread(scope, { threadId: otherThreadId, runId: sent.runId });
    expect(waited).toMatchObject({ status: "interrupted", timedOut: false });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("lists the caller's project by default and another project on request", () =>
  Effect.gen(function* () {
    yield* seedThreads;
    const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;

    const own = yield* mcp.listThreads(scope, {});
    expect(own.projectId).toBe(callerProjectId);
    expect(own.threads.map((thread) => thread.threadId)).toEqual([callerThreadId]);

    const other = yield* mcp.listThreads(scope, { projectId: otherProjectId });
    expect(other.projectId).toBe(otherProjectId);
    expect(other.threads.map((thread) => thread.threadId)).toEqual([otherThreadId]);

    const missing = yield* mcp
      .listThreads(scope, { projectId: ProjectId.make("project:missing") })
      .pipe(Effect.flip);
    expect(missing.message).toContain("project:missing");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("thread toolkit tools read and search threads in every project", () =>
  Effect.gen(function* () {
    yield* seedThreads;
    const dependencies = Layer.mergeAll(
      crossProjectLayer,
      NodeServices.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      Layer.mock(ThreadSearch.ThreadSearch)({
        search: () =>
          Effect.succeed({
            matches: [
              { threadId: callerThreadId, projectId: callerProjectId },
              { threadId: otherThreadId, projectId: otherProjectId },
            ].map((match) => ({
              ...match,
              source: "user" as const,
              snippet: "shared term",
              messageCreatedAt: null,
            })),
          }),
      }),
    );
    const toolkit = yield* ThreadToolkit.pipe(
      Effect.provide(ThreadToolkitHandlersLive.pipe(Layer.provide(dependencies))),
    );
    const call = (...args: Parameters<typeof toolkit.handle>) =>
      toolkit.handle(...args).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((results) => results.at(-1)?.result),
        Effect.provide(dependencies),
      );

    expect(yield* call("t3_thread_configuration", { threadId: otherThreadId })).toMatchObject({
      threadId: otherThreadId,
    });
    expect(yield* call("t3_thread_search", { query: "shared term" })).toMatchObject({
      matches: [{ projectId: callerProjectId }, { projectId: otherProjectId }],
    });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("keeps project scoping outside MCP and still hides deleted threads", () =>
  Effect.gen(function* () {
    yield* seedThreads;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const scoped = yield* threads
      .getProjectThread({ projectId: callerProjectId, threadId: otherThreadId })
      .pipe(Effect.flip);
    expect(scoped).toBeInstanceOf(ThreadManagementService.ThreadManagementThreadNotFoundError);

    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("command:delete:cross-project-other"),
      threadId: otherThreadId,
    });
    const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
    const deleted = yield* mcp.readThread(scope, { threadId: otherThreadId }).pipe(Effect.flip);
    expect(deleted.code).toBe("thread_not_found");
  }).pipe(Effect.provide(testLayer)),
);
