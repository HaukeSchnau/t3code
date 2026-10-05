import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type RuntimeMode,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2Shape,
} from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "../orchestration-v2/testkit/ReplayFixtureWorkspace.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as AgentWatches from "./AgentWatches.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const selection = { instanceId, model: "gpt-5.4" } satisfies ModelSelection;
const projectId = ProjectId.make("project:agent-watches");
const watcherId = ThreadId.make("thread:watcher");
const targetId = ThreadId.make("thread:target");

/** Completes every turn, except that a gated thread's turns wait for their gate. */
function makeAdapter(gates: Map<ThreadId, Deferred.Deferred<void>>): ProviderAdapterV2Shape {
  return {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (session) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const publish = (batch: ReadonlyArray<ProviderAdapterV2Event>) =>
          PubSub.publishAll(events, batch);
        const unused = () => Effect.die("unused in watch tests");
        return {
          instanceId,
          driver,
          providerSessionId: session.providerSessionId,
          providerSession: {
            id: session.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: session.runtimePolicy.cwd ?? process.cwd(),
            model: session.modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromPubSub(events),
          ensureThread: (thread) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${thread.threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: session.providerSessionId,
              appThreadId: thread.threadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver,
                nativeId: `native:${thread.threadId}`,
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
            } satisfies OrchestrationV2ProviderThread),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Effect.gen(function* () {
              const at = yield* DateTime.now;
              const providerTurn = {
                id: ProviderTurnId.make(`provider-turn:${turn.threadId}:${turn.runOrdinal}`),
                providerThreadId: turn.providerThread.id,
                nodeId: turn.rootNodeId,
                runAttemptId: turn.attemptId,
                nativeTurnRef: {
                  driver,
                  nativeId: `native-turn:${turn.threadId}:${turn.runOrdinal}`,
                  strength: "strong" as const,
                },
                ordinal: turn.providerTurnOrdinal,
                startedAt: at,
              };
              yield* publish([
                {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: { ...providerTurn, status: "running", completedAt: null },
                },
              ]);
              const gate = gates.get(turn.threadId);
              if (gate !== undefined) yield* Deferred.await(gate);
              yield* publish([
                {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: { ...providerTurn, status: "completed", completedAt: at },
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    id: TurnItemId.make(`turn-item:${turn.threadId}:${turn.runOrdinal}`),
                    threadId: turn.threadId,
                    runId: turn.runId,
                    nodeId: turn.rootNodeId,
                    providerThreadId: turn.providerThread.id,
                    providerTurnId: providerTurn.id,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: turn.runOrdinal * 100 + 1,
                    status: "completed",
                    title: null,
                    startedAt: at,
                    completedAt: at,
                    updatedAt: at,
                    type: "assistant_message",
                    messageId: MessageId.make(`message:${turn.threadId}:${turn.runOrdinal}:reply`),
                    text: "Done.",
                    streaming: false,
                  },
                },
                {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId: providerTurn.id,
                  runOrdinal: turn.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ]);
            }),
          steerTurn: () => Effect.void,
          interruptTurn: unused,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: unused,
          rollbackThread: unused,
          forkThread: unused,
        };
      }),
  };
}

const runtimeLayer = (cwd: string, gates: Map<ThreadId, Deferred.Deferred<void>>) => {
  const orchestrator = makeOrchestratorV2ReplayLayerWithRegistry(
    {
      name: "agent-watches",
      runtimePolicyOverride: {
        cwd,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
      },
    },
    ProviderAdapterRegistry.makeLayer([makeAdapter(gates)]),
  );
  return Layer.mergeAll(
    orchestrator,
    ThreadManagementService.layer.pipe(Layer.provide(orchestrator)),
    ProjectStore.layer,
    NodeServices.layer,
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory));
};

/** A real orchestrator with a watcher thread and a target thread whose turns wait for `release`. */
const withRuntime = <A, E>(
  body: (input: {
    readonly cwd: string;
    readonly release: Effect.Effect<void>;
    readonly createThread: (
      threadId: ThreadId,
      title: string,
      runtimeMode?: RuntimeMode,
    ) => Effect.Effect<Orchestrator.OrchestratorV2DispatchResult, Orchestrator.OrchestratorV2Error>;
    readonly send: (
      threadId: ThreadId,
      key: string,
    ) => Effect.Effect<Orchestrator.OrchestratorV2DispatchResult, Orchestrator.OrchestratorV2Error>;
  }) => Effect.Effect<
    A,
    E,
    | Orchestrator.OrchestratorV2
    | ThreadManagementService.ThreadManagementService
    | ProjectStore.ProjectStoreV2
    | SqlClient.SqlClient
    | NodeServices.NodeServices
    | Scope.Scope
  >,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("agent-watches");
      const gate = yield* Deferred.make<void>();
      const gates = new Map([[targetId, gate]]);
      return yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const createThread = (threadId: ThreadId, title: string, runtimeMode?: RuntimeMode) =>
          orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`command:${threadId}:create`),
            threadId,
            projectId,
            title,
            modelSelection: selection,
            runtimeMode: runtimeMode ?? "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
        const send = (threadId: ThreadId, key: string) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`command:${threadId}:${key}`),
            threadId,
            messageId: MessageId.make(`message:${threadId}:${key}`),
            text: `Work on ${key}.`,
            attachments: [],
            modelSelection: selection,
            dispatchMode: { type: "start_immediately" },
          });
        yield* createThread(watcherId, "Coordinator");
        yield* createThread(targetId, "Fix login");
        return yield* body({
          cwd,
          release: Deferred.succeed(gate, undefined).pipe(Effect.asVoid),
          createThread,
          send,
        });
      }).pipe(Effect.provide(runtimeLayer(cwd, gates)));
    }),
  );

type MessageEvent = Extract<OrchestrationV2DomainEvent, { readonly type: "message.updated" }>;

/** Waits for durable notification messages in a thread, in arrival order. */
const awaitNotifications = (threadId: ThreadId, count: number) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const seen = new Set<string>();
    const messages = yield* threads.streamStoredEventsFrom({ threadId, afterSequence: 0 }).pipe(
      Stream.map((stored) => stored.event),
      Stream.filter((event): event is MessageEvent => event.type === "message.updated"),
      Stream.map((event) => event.payload),
      Stream.filter((message) => {
        if (message.notification === undefined || seen.has(message.id)) return false;
        seen.add(message.id);
        return true;
      }),
      Stream.take(count),
      Stream.runCollect,
    );
    return Array.from(messages);
  });

const awaitTargetFinished = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  yield* threads.streamStoredEventsFrom({ threadId: targetId, afterSequence: 0 }).pipe(
    Stream.filter(
      (stored) =>
        stored.event.type === "run.updated" &&
        ThreadManagementService.isTerminalRunStatus(stored.event.payload.status),
    ),
    Stream.runHead,
  );
});

const notificationMessages = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const { messages } = yield* threads.getThreadRecords(threadId, ["messages"]);
    return messages.filter((message) => message.notification !== undefined);
  });

describe("thread watches", () => {
  it.live("wake the watcher once when the watched run finishes", () =>
    withRuntime(({ release, send }) =>
      Effect.gen(function* () {
        const watches = yield* AgentWatches.make;
        yield* watches.start;
        yield* send(targetId, "login");
        const watch = yield* watches.create({
          watcherThreadId: watcherId,
          source: { type: "thread", threadId: targetId },
          label: "Login fix",
        });
        assert.equal(watch.state, "open");

        yield* release;
        const [message] = yield* awaitNotifications(watcherId, 1);
        assert.isDefined(message);
        assert.deepEqual(message.notification, {
          source: { kind: "monitor" },
          outcome: "completed",
          summary: 'Login fix: Thread "Fix login" completed',
        });
        assert.equal(message.createdBy, "agent");
        assert.equal(message.creationSource, "server");
        assert.include(message.text, targetId);

        const [closed] = yield* watches.list({ watcherThreadId: watcherId, includeClosed: true });
        assert.deepInclude(closed, { state: "closed", closeReason: "fired" });
        assert.lengthOf(
          yield* watches.list({ watcherThreadId: watcherId, includeClosed: false }),
          0,
        );
      }),
    ),
  );

  it.live("fire at once when the run finished before the watch arrived", () =>
    withRuntime(({ release, send }) =>
      Effect.gen(function* () {
        const watches = yield* AgentWatches.make;
        yield* release;
        yield* send(targetId, "fast");
        yield* awaitTargetFinished;

        const watch = yield* watches.create({
          watcherThreadId: watcherId,
          source: { type: "thread", threadId: targetId },
        });
        assert.deepInclude(watch, { state: "closed", closeReason: "fired" });
        assert.lengthOf(yield* notificationMessages(watcherId), 1);
      }),
    ),
  );

  it.live("resume after a restart and never deliver twice", () =>
    withRuntime(({ release, send }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* send(targetId, "slow");
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const [run] = (yield* threads.getThreadRecords(targetId, ["runs"])).runs;
        assert.isDefined(run);
        const watch = yield* Effect.scoped(
          Effect.gen(function* () {
            const watches = yield* AgentWatches.make;
            yield* watches.start;
            return yield* watches.create({
              watcherThreadId: watcherId,
              source: { type: "thread", threadId: targetId, runId: run.id },
            });
          }),
        );
        // The target finishes while no watch service runs.
        yield* release;
        yield* awaitTargetFinished;

        const restarted = yield* AgentWatches.make;
        yield* restarted.start;
        assert.lengthOf(yield* notificationMessages(watcherId), 1);

        // A crash after delivery but before the close was stored replays the
        // same wake-up, which the orchestrator receipts absorb.
        yield* sql`
          UPDATE agent_watches SET state = 'open', close_reason = NULL, closed_at = NULL
          WHERE watch_id = ${watch.watchId}
        `;
        const again = yield* AgentWatches.make;
        yield* again.start;
        assert.lengthOf(yield* notificationMessages(watcherId), 1);
      }),
    ),
  );

  it.live("close without waking when the watcher is archived or the deadline passes", () =>
    withRuntime(({ send, createThread }) =>
      Effect.gen(function* () {
        yield* send(targetId, "long");
        const expired = yield* Effect.gen(function* () {
          const watches = yield* AgentWatches.make;
          const past = DateTime.formatIso(
            DateTime.subtractDuration(yield* DateTime.now, "1 minute"),
          );
          return yield* watches.create({
            watcherThreadId: watcherId,
            source: { type: "thread", threadId: targetId },
            deadline: past,
          });
        }).pipe(Effect.scoped);
        assert.deepInclude(expired, { state: "closed", closeReason: "deadline" });

        const otherWatcher = ThreadId.make("thread:other-watcher");
        yield* createThread(otherWatcher, "Other coordinator");
        const pending = yield* Effect.scoped(
          Effect.gen(function* () {
            const watches = yield* AgentWatches.make;
            const later = yield* watches.create({
              watcherThreadId: otherWatcher,
              source: { type: "thread", threadId: targetId },
              deadline: "30 minutes",
            });
            assert.deepInclude(later, { state: "open" });
            const invalid = yield* watches
              .create({
                watcherThreadId: otherWatcher,
                source: { type: "thread", threadId: targetId },
                deadline: "soon",
              })
              .pipe(Effect.flip);
            assert.equal(invalid._tag, "AgentWatchInputError");
            return later;
          }),
        );

        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("command:other-watcher:archive"),
          threadId: otherWatcher,
        });
        const restarted = yield* AgentWatches.make;
        yield* restarted.start;
        const [archived] = yield* restarted.list({
          watcherThreadId: otherWatcher,
          includeClosed: true,
        });
        assert.deepInclude(archived, {
          watchId: pending.watchId,
          state: "closed",
          closeReason: "watcher_closed",
        });
        assert.lengthOf(yield* notificationMessages(otherWatcher), 0);
      }),
    ),
  );
});

describe("command watches", () => {
  it.live("wake once per output burst and once more on exit", () =>
    withRuntime(({ cwd, createThread }) =>
      Effect.gen(function* () {
        const watches = yield* AgentWatches.make;
        const watch = yield* watches.create({
          watcherThreadId: watcherId,
          source: { type: "command", command: "printf 'one\\ntwo\\n'; exit 3" },
        });
        assert.deepInclude(watch.source, { type: "command", cwd });

        const [output, exit] = yield* awaitNotifications(watcherId, 2);
        assert.deepEqual(output?.notification, {
          source: { kind: "monitor" },
          outcome: "updated",
          summary: `Watch "printf 'one\\ntwo\\n'; exit 3" reported new output`,
          detail: "one\ntwo",
        });
        assert.deepEqual(exit?.notification, {
          source: { kind: "monitor" },
          outcome: "failed",
          summary: `Watch "printf 'one\\ntwo\\n'; exit 3" failed (exit 3)`,
        });
        const [closed] = yield* watches.list({ watcherThreadId: watcherId, includeClosed: true });
        assert.deepInclude(closed, { state: "closed", closeReason: "exited" });

        const supervised = ThreadId.make("thread:supervised");
        yield* createThread(supervised, "Supervised", "approval-required");
        const denied = yield* watches
          .create({ watcherThreadId: supervised, source: { type: "command", command: "true" } })
          .pipe(Effect.flip);
        assert.equal(denied._tag, "AgentWatchDeniedError");
      }),
    ),
  );

  it.live("stop the command when cancelled", () =>
    withRuntime(() =>
      Effect.gen(function* () {
        const watches = yield* AgentWatches.make;
        const watch = yield* watches.create({
          watcherThreadId: watcherId,
          source: { type: "command", command: "echo $$; exec sleep 600" },
          label: "Sleeper",
        });
        const [ready] = yield* awaitNotifications(watcherId, 1);
        assert.isDefined(ready);
        const pid = Number(ready.notification?.detail);

        const cancelled = yield* watches.cancel({
          watcherThreadId: watcherId,
          watchId: watch.watchId,
        });
        assert.deepInclude(cancelled, { state: "closed", closeReason: "cancelled" });
        assert.throws(() => process.kill(pid, 0));
        // A watch belongs to the thread that created it.
        const foreign = yield* watches
          .cancel({ watcherThreadId: targetId, watchId: watch.watchId })
          .pipe(Effect.flip);
        assert.equal(foreign._tag, "AgentWatchNotFoundError");
      }),
    ),
  );
});
