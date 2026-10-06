import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import { OrchestrationV2EventSinkLayerLive, OrchestrationV2LayerLive } from "./runtimeLayer.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const PlatformTestLayer = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);
const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-codex-turn-continuation-",
});

function testInstance(instanceId: string, driver: string): ProviderInstance {
  const driverKind = ProviderDriverKind.make(driver);
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driverKind,
    continuationIdentity: { driverKind, continuationKey: `${instanceId}:test` },
    displayName: instanceId,
    enabled: true,
    snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
    orchestrationAdapter: {
      instanceId: ProviderInstanceId.make(instanceId),
      driver: driverKind,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("provider sessions are not used by continuation tests"),
    } as ProviderAdapterV2Shape,
    textGeneration: {} as ProviderInstance["textGeneration"],
  };
}
const instances = [testInstance("codex", "codex"), testInstance("claude", "claudeAgent")];

const TestLayer = Layer.mergeAll(
  OrchestrationV2LayerLive,
  OrchestrationV2EventSinkLayerLive,
  ProjectStore.layer,
  EffectOutbox.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(
    CheckpointStore.layer.pipe(
      Layer.provide(VcsDriverRegistry.layer),
      Layer.provide(VcsProcess.layer),
      Layer.provide(ServerConfigLayer),
      Layer.provide(PlatformTestLayer),
    ),
  ),
  Layer.provide(ServerConfigLayer),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed(instances.find((instance) => instance.instanceId === instanceId)),
      listInstances: Effect.succeed(instances),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(GitWorkflow.GitWorkflowService)({
      pruneWorktrees: () => Effect.void,
      createWorktree: () => Effect.succeed({} as never),
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeed(Option.none()) }),
  ),
  Layer.provide(PlatformTestLayer),
);

/** A thread whose first run stopped the given way before any queued work. */
const stoppedThread = Effect.fn("stoppedThread")(function* (input: {
  readonly name: string;
  readonly instanceId: string;
  readonly stop: "interrupted" | "serverOverloaded";
}) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const events = yield* EventSink.EventSinkV2;
  const modelSelection: ModelSelection = {
    instanceId: ProviderInstanceId.make(input.instanceId),
    model: "gpt-5.4",
  };
  const threadId = ThreadId.make(`continuation:${input.name}`);
  const projectId = ProjectId.make(`continuation:project:${input.name}`);
  const now = yield* DateTime.now;
  yield* (yield* ProjectStore.ProjectStoreV2).apply({
    sequence: 0,
    eventId: EventId.make(`continuation:project:${input.name}`),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: DateTime.formatIso(now),
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: "Continuation project",
      workspaceRoot: process.cwd(),
      defaultModelSelection: modelSelection,
      scripts: [],
      createdAt: DateTime.formatIso(now),
      updatedAt: DateTime.formatIso(now),
    },
  });
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`continuation:create:${input.name}`),
    threadId,
    projectId,
    title: "Stopped thread",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`continuation:start:${input.name}`),
    threadId,
    messageId: MessageId.make(`continuation:start:${input.name}`),
    text: "Start work.",
    attachments: [],
    dispatchMode: { type: "defer_start" },
    createdBy: "user",
    creationSource: "web",
  });
  const source = (yield* orchestrator.getThreadProjection(threadId)).runs[0] as OrchestrationV2Run;
  yield* events.write({
    events: [
      {
        id: EventId.make(`continuation:stop:${input.name}`),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...source,
          status: input.stop === "interrupted" ? "interrupted" : "failed",
          completedAt: now,
        },
      },
      ...(input.stop === "serverOverloaded"
        ? [
            {
              id: EventId.make(`continuation:error:${input.name}`),
              type: "turn-item.updated" as const,
              threadId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`continuation:error:${input.name}`),
                type: "error" as const,
                threadId,
                runId: source.id,
                nodeId: source.rootNodeId,
                providerThreadId: source.providerThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 2,
                status: "failed" as const,
                title: "Provider error",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                failure: {
                  class: "provider_error" as const,
                  message: "Selected model is at capacity.",
                  code: "serverOverloaded",
                  retryable: null,
                },
              },
            },
          ]
        : []),
    ],
  });
  const resume = (text: string) =>
    orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`continuation:resume:${input.name}:${text.length}`),
      threadId,
      messageId: MessageId.make(`continuation:resume:${input.name}:${text.length}`),
      manualContinuationOfRunId: source.id,
      text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  return { threadId, source, resume };
});

it.layer(TestLayer)("Codex message-free continuation", (it) => {
  it.effect.each(["interrupted", "serverOverloaded"] as const)(
    "resumes a Codex run stopped by %s without a transcript message",
    (stop) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const { threadId, source, resume } = yield* stoppedThread({
          name: `codex-${stop}`,
          instanceId: "codex",
          stop,
        });
        yield* resume("");
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const continuation = projection.runs.find((run) => run.ordinal === source.ordinal + 1);
        assert.isDefined(continuation);
        assert.equal(
          projection.messages.find((message) => message.id === continuation!.userMessageId)?.text,
          "",
        );
        assert.isFalse(
          projection.turnItems.some(
            (item) => item.type === "user_message" && item.runId === continuation!.id,
          ),
        );
      }),
  );

  it.effect("keeps other providers on the visible Continue message", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, resume } = yield* stoppedThread({
        name: "claude-interrupted",
        instanceId: "claude",
        stop: "interrupted",
      });
      assert.equal((yield* resume("").pipe(Effect.exit))._tag, "Failure");
      yield* resume("Continue where you left off.");
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(projection.runs, 2);
      assert.isTrue(
        projection.turnItems.some(
          (item) =>
            item.type === "user_message" &&
            item.runId === projection.runs[1]!.id &&
            item.text === "Continue where you left off.",
        ),
      );
    }),
  );
});
