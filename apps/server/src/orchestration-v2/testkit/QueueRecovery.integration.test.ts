import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import {
  type ProviderAdapterV2Event,
  ProviderAdapterProtocolError,
  type ProviderAdapterV2Shape,
} from "../ProviderAdapter.ts";
import { makeLayer as makeProviderAdapterRegistryLayer } from "../ProviderAdapterRegistry.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" } as const;

type InitialTerminal = "failed" | "interrupted";

interface RecoveryState {
  readonly initialTerminal: InitialTerminal;
  readonly firstTurnStarted: Deferred.Deferred<void>;
  readonly releaseFirstTurn: Deferred.Deferred<void>;
  readonly terminalRuns: Ref.Ref<ReadonlyArray<number>>;
  readonly starts: Ref.Ref<ReadonlyArray<number>>;
}

function makeProviderThread(
  threadId: ThreadId,
  providerSessionId: ProviderSessionId,
  now: DateTime.Utc,
): OrchestrationV2ProviderThread {
  return {
    id: ProviderThreadId.make(`provider-thread:queue-recovery:${threadId}`),
    driver,
    providerInstanceId: instanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: {
      driver,
      nativeId: `native-thread:queue-recovery:${threadId}`,
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
}

function makeProviderTurn(input: {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly turnId: ProviderTurnId;
  readonly threadId: ThreadId;
  readonly runAttemptId: RunAttemptId;
  readonly nodeId: NodeId;
  readonly ordinal: number;
  readonly status: OrchestrationV2ProviderTurn["status"];
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderTurn {
  return {
    id: input.turnId,
    providerThreadId: input.providerThread.id,
    nodeId: input.nodeId,
    runAttemptId: input.runAttemptId,
    nativeTurnRef: {
      driver,
      nativeId: `native-turn:queue-recovery:${input.threadId}:${input.ordinal}`,
      strength: "strong",
    },
    ordinal: input.ordinal,
    status: input.status,
    startedAt: input.now,
    completedAt: input.status === "running" ? null : input.now,
  };
}

function makeProviderAdapter(state: RecoveryState): ProviderAdapterV2Shape {
  return {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerThread = makeProviderThread(input.threadId, input.providerSessionId, now);
        let firstProviderTurn:
          | {
              readonly providerThread: OrchestrationV2ProviderThread;
              readonly providerTurnId: ProviderTurnId;
              readonly threadId: ThreadId;
              readonly runAttemptId: RunAttemptId;
              readonly nodeId: NodeId;
            }
          | undefined;

        const publishTerminal = (input: {
          readonly providerThread: OrchestrationV2ProviderThread;
          readonly providerTurnId: ProviderTurnId;
          readonly threadId: ThreadId;
          readonly runAttemptId: RunAttemptId;
          readonly nodeId: NodeId;
          readonly ordinal: number;
          readonly status: "completed" | "failed" | "interrupted";
          readonly now: DateTime.Utc;
        }) =>
          Effect.gen(function* () {
            const wasAlreadyTerminal = yield* Ref.modify(state.terminalRuns, (runs) =>
              runs.includes(input.ordinal)
                ? [true, runs]
                : [false, [...runs, input.ordinal]],
            );
            if (wasAlreadyTerminal) return;

            yield* PubSub.publish(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: makeProviderTurn({
                providerThread: input.providerThread,
                turnId: input.providerTurnId,
                threadId: input.threadId,
                runAttemptId: input.runAttemptId,
                nodeId: input.nodeId,
                ordinal: input.ordinal,
                status: input.status === "failed" ? "failed" : input.status,
                now: input.now,
              }),
            });
            if (input.status === "failed") {
              yield* PubSub.publish(events, {
                type: "turn.terminal",
                driver,
                providerThreadId: input.providerThread.id,
                providerTurnId: input.providerTurnId,
                runOrdinal: input.ordinal,
                failureItemOrdinal: input.ordinal * 100 + 1,
                status: "failed",
                failure: makeProviderFailure({
                  message: "Simulated provider failure.",
                  code: "simulated_failure",
                  class: "provider_error",
                }),
                threadDisposition: "reusable",
              });
            } else {
              yield* PubSub.publish(events, {
                type: "turn.terminal",
                driver,
                providerThreadId: input.providerThread.id,
                providerTurnId: input.providerTurnId,
                runOrdinal: input.ordinal,
                status: input.status,
                failure: null,
                threadDisposition: "reusable",
              });
            }
          });

        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: input.runtimePolicy.cwd ?? process.cwd(),
            model: input.modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          } satisfies OrchestrationV2ProviderSession,
          events: Stream.fromPubSub(events),
          ensureThread: () => Effect.succeed(providerThread),
          resumeThread: () => Effect.succeed(providerThread),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              yield* Ref.update(state.starts, (runs) => [...runs, turnInput.runOrdinal]);
              const startedAt = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:queue-recovery:${turnInput.runOrdinal}`,
              );
              yield* PubSub.publish(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: makeProviderTurn({
                  providerThread: turnInput.providerThread,
                  turnId: providerTurnId,
                  threadId: turnInput.threadId,
                  runAttemptId: turnInput.attemptId,
                  nodeId: turnInput.rootNodeId,
                  ordinal: turnInput.runOrdinal,
                  status: "running",
                  now: startedAt,
                }),
              });
              if (turnInput.runOrdinal === 1) {
                firstProviderTurn = {
                  providerThread: turnInput.providerThread,
                  providerTurnId,
                  threadId: turnInput.threadId,
                  runAttemptId: turnInput.attemptId,
                  nodeId: turnInput.rootNodeId,
                };
                yield* Deferred.succeed(state.firstTurnStarted, undefined);
                yield* Deferred.await(state.releaseFirstTurn);
              }
              const terminalRuns = yield* Ref.get(state.terminalRuns);
              if (terminalRuns.includes(turnInput.runOrdinal)) return;
              const now = yield* DateTime.now;
              if (turnInput.runOrdinal > 1) {
                yield* PubSub.publish(events, {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    id: TurnItemId.make(
                      `turn-item:queue-recovery:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: turnInput.runOrdinal * 100 + 1,
                    status: "completed",
                    title: null,
                    startedAt: now,
                    completedAt: now,
                    updatedAt: now,
                    type: "assistant_message",
                    messageId: MessageId.make(
                      `message:queue-recovery:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    text: `successful run ${turnInput.runOrdinal}`,
                    streaming: false,
                  },
                });
              }
              yield* publishTerminal({
                providerThread: turnInput.providerThread,
                providerTurnId,
                threadId: turnInput.threadId,
                runAttemptId: turnInput.attemptId,
                nodeId: turnInput.rootNodeId,
                ordinal: turnInput.runOrdinal,
                status: turnInput.runOrdinal === 1 ? state.initialTerminal : "completed",
                now,
              });
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () =>
            Effect.gen(function* () {
              if (firstProviderTurn === undefined) return;
              const now = yield* DateTime.now;
              yield* publishTerminal({
                ...firstProviderTurn,
                ordinal: 1,
                status: "interrupted",
                now,
              });
              yield* Deferred.succeed(state.releaseFirstTurn, undefined);
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () =>
            Effect.succeed({
              providerThread,
              providerTurns: [],
              messages: [],
              runtimeRequests: [],
            }),
          rollbackThread: () =>
            Effect.fail(
              new ProviderAdapterProtocolError({ driver, detail: "rollback is unused" }),
            ),
          forkThread: ({ sourceProviderThread }) => Effect.succeed(sourceProviderThread),
        };
      }),
  };
}

function waitForRunStatus(
  orchestrator: OrchestratorV2["Service"],
  threadId: ThreadId,
  afterSequence: number,
  status: "completed" | "failed" | "interrupted",
) {
  return orchestrator.streamStoredEventsFrom({ threadId, afterSequence }).pipe(
    Stream.filter(
      (stored) =>
        stored.event.type === "run.updated" && stored.event.payload.status === status,
    ),
    Stream.runHead,
    Effect.flatMap((stored) =>
      Option.match(stored, {
        onNone: () => Effect.die(new Error(`Missing ${status} run receipt.`)),
        onSome: Effect.succeed,
      }),
    ),
  );
}

const runRecoveryCase = Effect.fn("runQueueRecoveryCase")(function* (
  initialTerminal: InitialTerminal,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* Effect.acquireRelease(
    fs.makeTempDirectory({ prefix: `t3-orchestration-v2-queue-${initialTerminal}-` }),
    (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
  );
  const dbPath = path.join(tempDir, "state.sqlite");
  const databaseLayer = makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer));
  const firstTurnStarted = yield* Deferred.make<void>();
  const releaseFirstTurn = yield* Deferred.make<void>();
  const state: RecoveryState = {
    initialTerminal,
    firstTurnStarted,
    releaseFirstTurn,
    terminalRuns: yield* Ref.make<ReadonlyArray<number>>([]),
    starts: yield* Ref.make<ReadonlyArray<number>>([]),
  };
  const registryLayer = makeProviderAdapterRegistryLayer([makeProviderAdapter(state)]);
  const layer = (name: string) =>
    makeOrchestratorV2ReplayLayerWithRegistry(
      { name, runtimePolicyOverride: { cwd: process.cwd() } },
      registryLayer,
      { databaseLayer },
    );
  const threadId = ThreadId.make(`thread:queue-recovery:${initialTerminal}`);
  const projectId = ProjectId.make(`project:queue-recovery:${initialTerminal}`);

  yield* Effect.scoped(
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`command:queue-recovery:${initialTerminal}:create`),
        threadId,
        projectId,
        title: "Queue recovery",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`command:queue-recovery:${initialTerminal}:first`),
        threadId,
        messageId: MessageId.make(`message:queue-recovery:${initialTerminal}:first`),
        text: "The first run will stop.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      yield* Deferred.await(firstTurnStarted);
      const firstProjection = yield* orchestrator.getThreadProjection(threadId);
      const firstRun = firstProjection.runs.find((run) => run.ordinal === 1);
      assert.isDefined(firstRun);
      const firstRunId = firstRun!.id;

      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`command:queue-recovery:${initialTerminal}:queued`),
        threadId,
        messageId: MessageId.make(`message:queue-recovery:${initialTerminal}:queued`),
        text: "Keep this queued until recovery.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "queue_after_active" },
      });
      const queuedProjection = yield* orchestrator.getThreadProjection(threadId);
      const queuedRun = queuedProjection.runs.find((run) => run.status === "queued");
      assert.isDefined(queuedRun);

      const beforeTerminal = yield* orchestrator.getThreadEventSequence(threadId);
      const terminal = yield* waitForRunStatus(
        orchestrator,
        threadId,
        beforeTerminal,
        initialTerminal,
      ).pipe(Effect.forkScoped);
      if (initialTerminal === "failed") {
        yield* Deferred.succeed(releaseFirstTurn, undefined);
      } else {
        const interruptCommand = {
          type: "run.interrupt",
          commandId: CommandId.make(`command:queue-recovery:${initialTerminal}:interrupt`),
          threadId,
          runId: firstRunId,
          reason: "test interruption",
        } as const;
        yield* orchestrator.dispatch(interruptCommand);
        // Keep the provider start held until the interrupt command is durable,
        // then let the fixture publish its terminal interruption before the
        // restart scope opens.
        yield* Deferred.succeed(releaseFirstTurn, undefined);
      }
      yield* Fiber.join(terminal);
      const afterTerminal = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(afterTerminal.runs.find((run) => run.id === firstRunId)?.status, initialTerminal);
      assert.equal(afterTerminal.runs.find((run) => run.id === queuedRun!.id)?.status, "queued");
    }).pipe(Effect.provide(layer(`queue-recovery-${initialTerminal}-first`))),
  );

  yield* Effect.scoped(
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      assert.deepEqual(yield* Ref.get(state.starts), [1]);
      const restarted = yield* orchestrator.getThreadProjection(threadId);
      const queuedRun = restarted.runs.find((run) => run.status === "queued");
      assert.isDefined(queuedRun);
      assert.equal(yield* orchestrator.resumeQueuedRuns, 0);
      assert.deepEqual(yield* Ref.get(state.starts), [1]);

      const beforeManualRun = yield* orchestrator.getThreadEventSequence(threadId);
      const completions = yield* orchestrator
        .streamStoredEventsFrom({ threadId, afterSequence: beforeManualRun })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" && stored.event.payload.status === "completed",
          ),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped,
        );
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`command:queue-recovery:${initialTerminal}:manual`),
        threadId,
        messageId: MessageId.make(`message:queue-recovery:${initialTerminal}:manual`),
        text: "Manually recover the queue.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      const completed = yield* Fiber.join(completions);
      assert.lengthOf(completed, 2);
      assert.deepEqual(yield* Ref.get(state.starts), [1, 3, 2]);

      const recovered = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        recovered.runs.map((run) => run.status),
        [initialTerminal, "completed", "completed"],
      );
      assert.equal(recovered.runs.find((run) => run.id === queuedRun!.id)?.status, "completed");
    }).pipe(Effect.provide(layer(`queue-recovery-${initialTerminal}-second`))),
  );
});

describe("orchestrator queue recovery", () => {
  it.effect("keeps failed queues paused across restart until a successful manual run", () =>
    runRecoveryCase("failed").pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("keeps interrupted queues paused across restart until a successful manual run", () =>
    runRecoveryCase("interrupted").pipe(Effect.provide(NodeServices.layer)),
  );
});
