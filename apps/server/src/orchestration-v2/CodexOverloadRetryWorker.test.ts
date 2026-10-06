import { assert, expect, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as CodexOverloadRetryWorker from "./CodexOverloadRetryWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const driver = ProviderDriverKind.make("codex");

/** Persists a Codex thread whose only run failed with the given provider error code. */
const seedFailedThread = Effect.fn("seedFailedThread")(function* (name: string, code: string) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:${name}`);
  const providerThreadId = ProviderThreadId.make(`provider-thread:${name}`);
  const rootNodeId = NodeId.make(`node:${name}`);
  const run: OrchestrationV2Run = {
    id: RunId.make(`run:${name}`),
    threadId,
    ordinal: 1,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId,
    userMessageId: MessageId.make(`message:${name}`),
    rootNodeId,
    activeAttemptId: null,
    status: "failed",
    requestedAt: now,
    startedAt: now,
    completedAt: now,
    checkpointId: null,
    contextHandoffId: null,
  };
  yield* store.apply({
    id: EventId.make(`event:${name}:thread`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make(`project:${name}`),
      title: "Overloaded thread",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  yield* store.apply({
    id: EventId.make(`event:${name}:provider-thread`),
    type: "provider-thread.updated",
    threadId,
    driver,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: {
      id: providerThreadId,
      driver,
      providerInstanceId: modelSelection.instanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  yield* store.apply({
    id: EventId.make(`event:${name}:run`),
    type: "run.created",
    threadId,
    runId: run.id,
    nodeId: rootNodeId,
    driver,
    providerInstanceId: modelSelection.instanceId,
    occurredAt: now,
    payload: run,
  });
  yield* store.apply({
    id: EventId.make(`event:${name}:error`),
    type: "turn-item.updated",
    threadId,
    runId: run.id,
    nodeId: rootNodeId,
    driver,
    occurredAt: now,
    payload: {
      id: TurnItemId.make(`item:${name}:error`),
      threadId,
      runId: run.id,
      nodeId: rootNodeId,
      providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 2,
      status: "failed",
      title: "Provider error",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "error",
      failure: {
        class: "provider_error",
        message: "Selected model is at capacity.",
        code,
        retryable: null,
      },
    },
  });
  return { threadId, runId: run.id };
});

const withWorker = <A, E, R>(
  commands: Queue.Queue<OrchestrationV2ServerCommand>,
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.provide(
      CodexOverloadRetryWorker.workerLive.pipe(
        Layer.provide(Scheduler.layer),
        Layer.provide(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            dispatch: (command) =>
              Queue.offer(commands, command).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
          }),
        ),
      ),
    ),
  );

const TestLayer = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.effect.each(["on time", "after restart"] as const)(
  "retries an overloaded Codex turn without a message %s",
  (scenario) =>
    Effect.gen(function* () {
      const { threadId, runId } = yield* seedFailedThread("overloaded", "serverOverloaded");
      const commands = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
      // A restarted server finds the persisted, overdue retry on its first sweep.
      if (scenario === "after restart") yield* TestClock.adjust("10 minutes");
      yield* withWorker(
        commands,
        Effect.gen(function* () {
          if (scenario === "on time") {
            yield* TestClock.adjust("3 seconds");
            assert.equal(yield* Queue.size(commands), 0);
            yield* TestClock.adjust("10 seconds");
          }
          expect(yield* Queue.take(commands)).toMatchObject({
            type: "message.dispatch",
            commandId: `codex-overload-retry:${runId}`,
            messageId: `codex-overload-retry:${runId}`,
            threadId,
            manualContinuationOfRunId: runId,
            text: "",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          });
        }),
      );
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("leaves other provider errors for the user", () =>
  Effect.gen(function* () {
    yield* seedFailedThread("context-window", "contextWindowExceeded");
    const commands = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
    yield* withWorker(
      commands,
      Effect.gen(function* () {
        yield* TestClock.adjust("10 minutes");
        assert.equal(yield* Queue.size(commands), 0);
      }),
    );
  }).pipe(Effect.provide(TestLayer)),
);
