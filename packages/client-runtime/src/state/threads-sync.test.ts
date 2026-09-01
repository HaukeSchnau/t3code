import {
  EnvironmentId,
  EventId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationThreadActivityDetailMode,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import * as RpcSession from "../rpc/session.ts";
import type { ThreadSnapshotLoadOutcome } from "./threadSnapshotHttp.ts";
import {
  AUTHORITATIVE_REFRESH_MAX_ATTEMPTS,
  AUTHORITATIVE_REFRESH_RETRY_CAP_MS,
  EMPTY_ENVIRONMENT_THREAD_STATE,
  authoritativeRefreshRetryDelayMs,
  makeEnvironmentThreadState,
  ThreadSnapshotLoader,
  type EnvironmentThreadState,
} from "./threads.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const THREAD_ID = ThreadId.make("thread-1");
const CACHED_SNAPSHOT_SEQUENCE = 7;
const authoritativeRefreshTestDelay = (attempt: number, clientSeed = 17) =>
  authoritativeRefreshRetryDelayMs({
    attempt,
    eventSequence: CACHED_SNAPSHOT_SEQUENCE + 1,
    clientSeed,
    environmentId: TARGET.environmentId,
    threadId: THREAD_ID,
  });
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};
const BASE_THREAD: OrchestrationThread = {
  id: THREAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Cached thread",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};
const ACTIVE_THREAD: OrchestrationThread = {
  ...BASE_THREAD,
  latestTurn: {
    turnId: TurnId.make("turn-1"),
    state: "running",
    requestedAt: "2026-04-01T00:01:00.000Z",
    startedAt: "2026-04-01T00:01:00.000Z",
    completedAt: null,
    assistantMessageId: null,
  },
  session: {
    threadId: THREAD_ID,
    status: "running",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: TurnId.make("turn-1"),
    lastError: null,
    updatedAt: "2026-04-01T00:01:00.000Z",
  },
};

type TestThreadInput = OrchestrationThreadStreamItem | Error;

function testSession(
  client: WsRpcProtocolClient,
  options?: { readonly completionMarker?: boolean },
): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.succeed(
      options?.completionMarker === true
        ? ({ threadResumeCompletionMarker: true } as never)
        : ({} as never),
    ),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

function awaitThreadState(
  observed: Queue.Queue<EnvironmentThreadState>,
  predicate: (state: EnvironmentThreadState) => boolean,
) {
  return Queue.take(observed).pipe(
    Effect.repeat({
      until: predicate,
    }),
  );
}

const makeHarness = Effect.fn("TestEnvironmentThreads.makeHarness")(function* (options?: {
  readonly cached?: OrchestrationThread;
  readonly cachedActivityDetailMode?: OrchestrationThreadActivityDetailMode;
  readonly httpSnapshot?: Option.Option<OrchestrationThreadDetailSnapshot>;
  readonly httpOutcomes?: ReadonlyArray<ThreadSnapshotLoadOutcome>;
  readonly httpOutcomeEffects?: ReadonlyArray<Effect.Effect<ThreadSnapshotLoadOutcome>>;
  readonly authoritativeRefreshJitterSeed?: number;
  readonly requestedActivityDetailMode?: OrchestrationThreadActivityDetailMode;
  readonly completionMarker?: boolean;
}) {
  const inputs = yield* Queue.unbounded<TestThreadInput>();
  const observed = yield* Queue.unbounded<EnvironmentThreadState>();
  const latest = yield* Ref.make<EnvironmentThreadState>(EMPTY_ENVIRONMENT_THREAD_STATE);
  const retryCount = yield* Ref.make(0);
  const subscriptionCount = yield* Ref.make(0);
  const subscriptionAttempts = yield* Queue.unbounded<{
    readonly clientId: string;
    readonly afterSequence: number | undefined;
  }>();
  const cancelledClients = yield* Queue.unbounded<string>();
  const loaderCalls = yield* Ref.make(0);
  const loaderModes = yield* Ref.make<ReadonlyArray<OrchestrationThreadActivityDetailMode>>([]);
  const subscribeAfterSequences = yield* Ref.make<ReadonlyArray<number | undefined>>([]);
  const lastSubscribeAfterSequence = yield* Ref.make<number | undefined>(undefined);
  const lastRequestCompletionMarker = yield* Ref.make<boolean | undefined>(undefined);
  const savedThreads = yield* Ref.make<ReadonlyArray<OrchestrationThreadDetailSnapshot>>([]);
  const removedThreads = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const wakeups = yield* Queue.unbounded<ConnectionWakeups.ConnectionWakeup>();
  const supervisorState = yield* SubscriptionRef.make<SupervisorConnectionState>(
    AVAILABLE_CONNECTION_STATE,
  );
  const streamFrom = (queue: Queue.Queue<TestThreadInput>) =>
    Stream.fromQueue(queue).pipe(
      Stream.mapEffect((input) =>
        input instanceof Error ? Effect.fail(input) : Effect.succeed(input),
      ),
    );
  const clientFor = (queue: Queue.Queue<TestThreadInput>, clientId: string) =>
    ({
      [ORCHESTRATION_WS_METHODS.subscribeThread]: (input: {
        readonly afterSequence?: number;
        readonly requestCompletionMarker?: boolean;
      }) =>
        Stream.unwrap(
          Ref.updateAndGet(subscriptionCount, (count) => count + 1).pipe(
            Effect.andThen(
              Ref.update(subscribeAfterSequences, (sequences) => [
                ...sequences,
                input.afterSequence,
              ]),
            ),
            Effect.andThen(Ref.set(lastSubscribeAfterSequence, input.afterSequence)),
            Effect.andThen(Ref.set(lastRequestCompletionMarker, input.requestCompletionMarker)),
            Effect.andThen(
              Queue.offer(subscriptionAttempts, {
                clientId,
                afterSequence: input.afterSequence,
              }),
            ),
            Effect.as(
              streamFrom(queue).pipe(Stream.ensuring(Queue.offer(cancelledClients, clientId))),
            ),
          ),
        ),
    }) as unknown as WsRpcProtocolClient;
  const client = clientFor(inputs, "initial");
  const supervisorSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.some(
      testSession(
        client,
        options?.completionMarker === true ? { completionMarker: true } : undefined,
      ),
    ),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
    Option.some(PREPARED),
  );
  const snapshotLoader = ThreadSnapshotLoader.of({
    loadTurnActivities: () => Effect.die("unused"),
    load: (_prepared, threadId, activityDetailMode) =>
      Effect.gen(function* () {
        const call = yield* Ref.updateAndGet(loaderCalls, (count) => count + 1);
        yield* Ref.update(loaderModes, (modes) => [...modes, activityDetailMode]);
        if (threadId !== THREAD_ID) return { _tag: "NotFound" as const };
        const outcomeEffects = options?.httpOutcomeEffects;
        if (outcomeEffects && outcomeEffects.length > 0) {
          return yield* outcomeEffects[Math.min(call - 1, outcomeEffects.length - 1)]!;
        }
        const outcomes = options?.httpOutcomes;
        if (outcomes && outcomes.length > 0) {
          return outcomes[Math.min(call - 1, outcomes.length - 1)]!;
        }
        return Option.match(
          options?.httpSnapshot ?? Option.none<OrchestrationThreadDetailSnapshot>(),
          {
            onNone: () => ({ _tag: "NotFound" as const }),
            onSome: (snapshot) => ({ _tag: "Found" as const, snapshot }),
          },
        );
      }),
  });
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: supervisorState,
    session: supervisorSession,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Ref.update(retryCount, (count) => count + 1),
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(Option.none()),
    saveShell: () => Effect.void,
    loadThread: (_environmentId, threadId) =>
      Effect.succeed(
        threadId === THREAD_ID && options?.cached !== undefined
          ? Option.some({
              snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
              activityDetailMode: options.cachedActivityDetailMode ?? "full",
              thread: options.cached,
            })
          : Option.none(),
      ),
    saveThread: (_environmentId, thread) =>
      Ref.update(savedThreads, (current) => [...current, thread]),
    removeThread: (_environmentId, threadId) =>
      Ref.update(removedThreads, (current) => [...current, threadId]),
    loadServerConfig: () => Effect.succeed(Option.none()),
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeed(Option.none()),
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const threadState = yield* makeEnvironmentThreadState(
    THREAD_ID,
    options?.requestedActivityDetailMode ?? "full",
    { authoritativeRefreshJitterSeed: options?.authoritativeRefreshJitterSeed ?? 17 },
  ).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
    Effect.provideService(ThreadSnapshotLoader, snapshotLoader),
    Effect.provideService(
      ConnectionWakeups.ConnectionWakeups,
      ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.fromQueue(wakeups) }),
    ),
  );
  yield* SubscriptionRef.changes(threadState).pipe(
    Stream.runForEach((state) =>
      Ref.set(latest, state).pipe(Effect.andThen(Queue.offer(observed, state))),
    ),
    Effect.forkScoped,
  );

  return {
    inputs,
    observed,
    latest,
    retryCount,
    subscriptionCount,
    subscriptionAttempts,
    cancelledClients,
    loaderCalls,
    loaderModes,
    subscribeAfterSequences,
    lastSubscribeAfterSequence,
    lastRequestCompletionMarker,
    supervisorState,
    supervisorSession,
    savedThreads,
    removedThreads,
    wakeups,
    replaceSessionUsing: (queue: Queue.Queue<TestThreadInput>, clientId = "replacement") =>
      SubscriptionRef.set(
        supervisorSession,
        Option.some(
          testSession(
            clientFor(queue, clientId),
            options?.completionMarker === true ? { completionMarker: true } : undefined,
          ),
        ),
      ),
    replaceSession: SubscriptionRef.set(
      supervisorSession,
      Option.some(
        testSession(
          client,
          options?.completionMarker === true ? { completionMarker: true } : undefined,
        ),
      ),
    ),
  };
});

describe("thread reconnect freshness", () => {
  it.effect("resumes a replacement session from the latest applied sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      expect(yield* Queue.take(harness.subscriptionAttempts)).toEqual({
        clientId: "initial",
        afterSequence: CACHED_SNAPSHOT_SEQUENCE,
      });
      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Current title", CACHED_SNAPSHOT_SEQUENCE + 1),
      );
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Current title",
      );

      const replacementInputs = yield* Queue.unbounded<TestThreadInput>();
      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 2,
        generation: 2,
        lastFailure: null,
        retryAt: null,
      });
      yield* harness.replaceSessionUsing(replacementInputs, "replacement");

      expect(yield* Queue.take(harness.cancelledClients)).toBe("initial");
      expect(yield* Queue.take(harness.subscriptionAttempts)).toEqual({
        clientId: "replacement",
        afterSequence: CACHED_SNAPSHOT_SEQUENCE + 1,
      });
      expect((yield* SubscriptionRef.get(harness.supervisorState)).generation).toBe(2);
      expect(yield* Ref.get(harness.subscribeAfterSequences)).toEqual([
        CACHED_SNAPSHOT_SEQUENCE,
        CACHED_SNAPSHOT_SEQUENCE + 1,
      ]);
      yield* awaitThreadState(harness.observed, (value) => value.status === "synchronizing");
      yield* Queue.offer(replacementInputs, { kind: "synchronized" });
      const replacementLive = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live",
      );
      expect(Option.getOrThrow(replacementLive.data).title).toBe("Current title");
    }),
  );

  it.effect("resumes an expected-failure retry from the latest applied sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Current title", CACHED_SNAPSHOT_SEQUENCE + 1),
      );
      yield* Queue.offer(harness.inputs, new Error("retry subscription"));
      yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.error));

      yield* TestClock.adjust("250 millis");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(harness.subscribeAfterSequences)).toEqual([
        CACHED_SNAPSHOT_SEQUENCE,
        CACHED_SNAPSHOT_SEQUENCE + 1,
      ]);
    }),
  );

  it.effect("returns a cached thread to live when catch-up has no new thread events", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: BASE_THREAD,
        completionMarker: true,
      });
      for (let index = 0; index < 50; index += 1) yield* Effect.yieldNow;

      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 2,
        generation: 2,
        lastFailure: null,
        retryAt: null,
      });
      yield* SubscriptionRef.set(harness.supervisorSession, Option.none());
      for (let index = 0; index < 20; index += 1) yield* Effect.yieldNow;
      yield* harness.replaceSession;
      for (let index = 0; index < 50; index += 1) yield* Effect.yieldNow;
      expect((yield* Ref.get(harness.latest)).status).toBe("synchronizing");
      yield* Queue.offer(harness.inputs, { kind: "synchronized" });
      for (let index = 0; index < 50; index += 1) yield* Effect.yieldNow;
      expect((yield* Ref.get(harness.latest)).status).toBe("live");
      const replacementInputs = yield* Queue.unbounded<TestThreadInput>();
      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 3,
        generation: 3,
        lastFailure: null,
        retryAt: null,
      });
      yield* harness.replaceSessionUsing(replacementInputs);
      for (let index = 0; index < 50; index += 1) yield* Effect.yieldNow;
      expect((yield* Ref.get(harness.latest)).status).toBe("synchronizing");
      yield* Queue.offer(harness.inputs, { kind: "synchronized" });
      for (let index = 0; index < 50; index += 1) yield* Effect.yieldNow;
      expect((yield* Ref.get(harness.latest)).status).toBe("synchronizing");
      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "offline",
        phase: "offline",
        stage: null,
        attempt: 1,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      });
      for (let index = 0; index < 50; index += 1) yield* Effect.yieldNow;
      yield* Queue.offer(replacementInputs, { kind: "synchronized" });
      for (let index = 0; index < 50; index += 1) yield* Effect.yieldNow;
      expect((yield* Ref.get(harness.latest)).status).toBe("synchronizing");
      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 3,
        generation: 3,
        lastFailure: null,
        retryAt: null,
      });
      yield* Queue.offer(replacementInputs, { kind: "synchronized" });
      for (let index = 0; index < 50; index += 1) yield* Effect.yieldNow;
      expect((yield* Ref.get(harness.latest)).status).toBe("live");
      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "offline",
        phase: "offline",
        stage: null,
        attempt: 1,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      });
      for (let index = 0; index < 50; index += 1) yield* Effect.yieldNow;
      expect((yield* Ref.get(harness.latest)).status).toBe("live");
      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connected",
        stage: null,
        attempt: 2,
        generation: 3,
        lastFailure: null,
        retryAt: null,
      });

      for (let index = 0; index < 50; index += 1) yield* Effect.yieldNow;
      const recovered = yield* Ref.get(harness.latest);
      expect(recovered.status).toBe("live");
      expect(Option.getOrThrow(recovered.data)).toEqual(BASE_THREAD);

      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "offline",
        phase: "offline",
        stage: null,
        attempt: 3,
        generation: 3,
        lastFailure: null,
        retryAt: null,
      });
      for (let index = 0; index < 50; index += 1) yield* Effect.yieldNow;
      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connected",
        stage: null,
        attempt: 3,
        generation: 3,
        lastFailure: null,
        retryAt: null,
      });
      for (let index = 0; index < 50; index += 1) yield* Effect.yieldNow;
      expect((yield* Ref.get(harness.latest)).status).toBe("synchronizing");
    }),
  );

  it.effect("does not make a missing thread live from a synchronization marker", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      for (let index = 0; index < 50; index += 1) yield* Effect.yieldNow;
      yield* Queue.offer(harness.inputs, { kind: "synchronized" });
      for (let index = 0; index < 50; index += 1) yield* Effect.yieldNow;
      const state = yield* Ref.get(harness.latest);
      expect(state.status).not.toBe("live");
      expect(Option.isNone(state.data)).toBe(true);
    }),
  );

  it.effect("does not resurrect a deleted thread from a synchronization marker", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      for (let index = 0; index < 50; index += 1) yield* Effect.yieldNow;
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, deleted());
      for (let index = 0; index < 50; index += 1) yield* Effect.yieldNow;
      expect((yield* Ref.get(harness.latest)).status).toBe("deleted");
      yield* Queue.offer(harness.inputs, { kind: "synchronized" });
      for (let index = 0; index < 50; index += 1) yield* Effect.yieldNow;
      const state = yield* Ref.get(harness.latest);
      expect(state.status).toBe("deleted");
      expect(Option.isNone(state.data)).toBe(true);
    }),
  );
});

const snapshot = (thread: OrchestrationThread): OrchestrationThreadStreamItem => ({
  kind: "snapshot",
  snapshot: {
    snapshotSequence: 1,
    activityDetailMode: "full",
    thread,
  },
});

const synchronized = (): OrchestrationThreadStreamItem => ({ kind: "synchronized" });

const titleUpdated = (title: string, sequence = 2): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make("event-title"),
    sequence,
    occurredAt: "2026-04-01T01:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.meta-updated",
    payload: {
      threadId: THREAD_ID,
      title,
      updatedAt: "2026-04-01T01:00:00.000Z",
    },
  },
});

const queuedMessage = (sequence = 2): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make("event-queued-message"),
    sequence,
    occurredAt: "2026-04-01T01:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.message-queued",
    payload: {
      threadId: THREAD_ID,
      queuedMessage: {
        messageId: MessageId.make("message-queued-1"),
        threadId: THREAD_ID,
        text: "Queued follow-up",
        attachments: [],
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-04-01T01:00:00.000Z",
        updatedAt: "2026-04-01T01:00:00.000Z",
      },
    },
  },
});

const deleted = (sequence = 3): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make("event-deleted"),
    sequence,
    occurredAt: "2026-04-01T02:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.deleted",
    payload: {
      threadId: THREAD_ID,
      deletedAt: "2026-04-01T02:00:00.000Z",
    },
  },
});

const compactThreadWithHistory = (): OrchestrationThread => ({
  ...BASE_THREAD,
  latestTurn: {
    turnId: TurnId.make("turn-current"),
    state: "running",
    requestedAt: "2026-04-01T01:00:00.000Z",
    startedAt: "2026-04-01T01:00:00.000Z",
    completedAt: null,
    assistantMessageId: null,
  },
  historicalActivityGroups: [
    {
      turnId: TurnId.make("turn-history"),
      revision: CACHED_SNAPSHOT_SEQUENCE,
      activityCount: 2,
      payloadBytes: 100,
      displayActivityCount: 1,
      firstActivityAt: "2026-04-01T00:00:00.000Z",
      lastActivityAt: "2026-04-01T00:30:00.000Z",
    },
  ],
});

const historicalActivityAppended = (
  sequence = CACHED_SNAPSHOT_SEQUENCE + 1,
): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make(`event-historical-activity-${sequence}`),
    sequence,
    occurredAt: "2026-04-01T01:01:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.activity-appended",
    payload: {
      threadId: THREAD_ID,
      activity: {
        id: EventId.make("historical-activity-new"),
        tone: "tool",
        kind: "tool.completed",
        summary: "Historical command",
        payload: { output: "large" },
        turnId: TurnId.make("turn-history"),
        sequence,
        createdAt: "2026-04-01T00:45:00.000Z",
      },
    },
  },
});

describe("EnvironmentThreads", () => {
  it("uses capped exponential authoritative-refresh delays with deterministic jitter", () => {
    const delays = Array.from({ length: 12 }, (_, attempt) =>
      authoritativeRefreshTestDelay(attempt),
    );

    expect(delays).toEqual(
      Array.from({ length: 12 }, (_, attempt) => authoritativeRefreshTestDelay(attempt)),
    );
    expect(delays.every((delay) => delay <= AUTHORITATIVE_REFRESH_RETRY_CAP_MS)).toBe(true);
    expect(delays[0]).toBeLessThan(delays[1]!);
    expect(delays.at(-1)).toBeLessThanOrEqual(AUTHORITATIVE_REFRESH_RETRY_CAP_MS);
    expect(authoritativeRefreshTestDelay(1, 17)).not.toBe(authoritativeRefreshTestDelay(1, 29));
  });
  it.effect("publishes cached data immediately from a warm cache", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      const state = yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));

      expect(Option.getOrThrow(state.data)).toEqual(BASE_THREAD);
      expect(Option.isNone(state.error)).toBe(true);
    }),
  );

  it.effect("resumes a warm cache via afterSequence without an HTTP fetch", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });

      // The warm cache reaches live from the cached data, and a live event
      // applies on top of it.
      yield* Queue.offer(harness.inputs, titleUpdated("Live title", CACHED_SNAPSHOT_SEQUENCE + 1));
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Live title",
      );

      // The subscription resumed from the cached sequence and never fetched the
      // full snapshot over HTTP.
      expect((yield* Ref.get(harness.subscribeAfterSequences)).at(-1)).toBe(
        CACHED_SNAPSHOT_SEQUENCE,
      );
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);
    }),
  );

  it.effect("rejects a warm cache with the wrong activity detail mode", () =>
    Effect.gen(function* () {
      const compactThread: OrchestrationThread = {
        ...BASE_THREAD,
        title: "Compact HTTP title",
      };
      const harness = yield* makeHarness({
        cached: BASE_THREAD,
        cachedActivityDetailMode: "full",
        requestedActivityDetailMode: "compact",
        httpSnapshot: Option.some({
          snapshotSequence: CACHED_SNAPSHOT_SEQUENCE + 1,
          activityDetailMode: "compact",
          thread: compactThread,
        }),
      });
      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Compact live title", CACHED_SNAPSHOT_SEQUENCE + 2),
      );

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Compact live title",
      );

      expect(Option.getOrThrow(state.data).title).toBe("Compact live title");
      expect(yield* Ref.get(harness.loaderCalls)).toBeGreaterThanOrEqual(1);
      expect((yield* Ref.get(harness.loaderModes)).at(-1)).toBe("compact");
      expect((yield* Ref.get(harness.subscribeAfterSequences)).at(-1)).toBe(
        CACHED_SNAPSHOT_SEQUENCE + 1,
      );
    }),
  );

  it.effect("reloads compact history authoritatively without losing the event cursor", () =>
    Effect.gen(function* () {
      const historicalTurnId = TurnId.make("turn-history");
      const compactThread: OrchestrationThread = {
        ...BASE_THREAD,
        latestTurn: {
          turnId: TurnId.make("turn-current"),
          state: "running",
          requestedAt: "2026-04-01T01:00:00.000Z",
          startedAt: "2026-04-01T01:00:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
        historicalActivityGroups: [
          {
            turnId: historicalTurnId,
            revision: CACHED_SNAPSHOT_SEQUENCE,
            activityCount: 2,
            payloadBytes: 100,
            displayActivityCount: 1,
            firstActivityAt: "2026-04-01T00:00:00.000Z",
            lastActivityAt: "2026-04-01T00:30:00.000Z",
          },
        ],
      };
      const refreshedThread: OrchestrationThread = {
        ...compactThread,
        title: "Authoritative snapshot",
        historicalActivityGroups: [
          {
            ...compactThread.historicalActivityGroups![0]!,
            revision: CACHED_SNAPSHOT_SEQUENCE + 1,
            activityCount: 3,
            payloadBytes: 120,
            displayActivityCount: 2,
          },
        ],
      };
      const harness = yield* makeHarness({
        cached: compactThread,
        cachedActivityDetailMode: "compact",
        requestedActivityDetailMode: "compact",
        httpOutcomes: [
          {
            _tag: "Found",
            snapshot: {
              snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
              activityDetailMode: "compact",
              thread: compactThread,
            },
          },
          {
            _tag: "Found",
            snapshot: {
              // Includes this event plus a later committed event, so queued
              // socket sequence 9 must be ignored after replacement.
              snapshotSequence: CACHED_SNAPSHOT_SEQUENCE + 3,
              activityDetailMode: "compact",
              thread: refreshedThread,
            },
          },
        ],
      });
      yield* Queue.offer(harness.inputs, {
        kind: "event",
        event: {
          eventId: EventId.make("event-historical-activity"),
          sequence: CACHED_SNAPSHOT_SEQUENCE + 1,
          occurredAt: "2026-04-01T01:01:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          aggregateKind: "thread",
          aggregateId: THREAD_ID,
          type: "thread.activity-appended",
          payload: {
            threadId: THREAD_ID,
            activity: {
              id: EventId.make("historical-activity-new"),
              tone: "tool",
              kind: "tool.completed",
              summary: "Historical command",
              payload: { output: "large" },
              turnId: historicalTurnId,
              sequence: CACHED_SNAPSHOT_SEQUENCE + 1,
              createdAt: "2026-04-01T00:45:00.000Z",
            },
          },
        },
      });
      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Stale queued title", CACHED_SNAPSHOT_SEQUENCE + 2),
      );
      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Fresh socket title", CACHED_SNAPSHOT_SEQUENCE + 4),
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.loaderCalls)) >= 1) break;
        yield* Effect.yieldNow;
      }
      yield* TestClock.adjust(authoritativeRefreshTestDelay(0) + 1);

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Fresh socket title",
      );

      expect(Option.getOrThrow(state.data).historicalActivityGroups?.[0]).toMatchObject({
        revision: CACHED_SNAPSHOT_SEQUENCE + 1,
        activityCount: 3,
        payloadBytes: 120,
        displayActivityCount: 2,
      });
      expect(yield* Ref.get(harness.loaderCalls)).toBe(2);
      expect(yield* Ref.get(harness.loaderModes)).toEqual(["compact", "compact"]);
      expect(yield* Ref.get(harness.subscribeAfterSequences)).toEqual([CACHED_SNAPSHOT_SEQUENCE]);
    }),
  );

  it.effect(
    "falls back to a fresh snapshot after authoritative refresh retries are exhausted",
    () =>
      Effect.gen(function* () {
        const compactThread = compactThreadWithHistory();
        const recoveredThread = { ...compactThread, title: "Recovered from fresh snapshot" };
        const harness = yield* makeHarness({
          cached: compactThread,
          cachedActivityDetailMode: "compact",
          requestedActivityDetailMode: "compact",
          completionMarker: true,
          httpOutcomes: Array.from({ length: AUTHORITATIVE_REFRESH_MAX_ATTEMPTS }, () => ({
            _tag: "TransientFailure" as const,
            message: "temporary snapshot failure",
          })),
        });
        expect(yield* Queue.take(harness.subscriptionAttempts)).toMatchObject({
          afterSequence: CACHED_SNAPSHOT_SEQUENCE,
        });
        yield* Queue.offer(harness.inputs, historicalActivityAppended());

        for (let attempt = 0; attempt < AUTHORITATIVE_REFRESH_MAX_ATTEMPTS; attempt += 1) {
          for (let spin = 0; spin < 100; spin += 1) {
            if ((yield* Ref.get(harness.loaderCalls)) >= attempt + 1) break;
            yield* Effect.yieldNow;
          }
          if (attempt < AUTHORITATIVE_REFRESH_MAX_ATTEMPTS - 1) {
            yield* TestClock.adjust(authoritativeRefreshTestDelay(attempt) + 1);
          }
        }
        yield* TestClock.adjust("51 millis");
        const restarted = yield* Queue.take(harness.subscriptionAttempts);

        expect(restarted.afterSequence).toBeUndefined();
        expect(yield* Ref.get(harness.loaderCalls)).toBe(AUTHORITATIVE_REFRESH_MAX_ATTEMPTS);
        expect(Option.isSome((yield* Ref.get(harness.latest)).error)).toBe(true);

        yield* Queue.offer(harness.inputs, {
          kind: "snapshot",
          snapshot: {
            snapshotSequence: CACHED_SNAPSHOT_SEQUENCE + 1,
            activityDetailMode: "compact",
            thread: recoveredThread,
          },
        });
        yield* Queue.offer(harness.inputs, synchronized());

        const recovered = yield* awaitThreadState(
          harness.observed,
          (value) =>
            value.status === "live" &&
            Option.isSome(value.data) &&
            value.data.value.title === recoveredThread.title,
        );
        expect(Option.isNone(recovered.error)).toBe(true);
      }),
  );

  it.effect("interrupts refresh backoff when the connection generation changes", () =>
    Effect.gen(function* () {
      const compactThread = compactThreadWithHistory();
      const refreshedThread = { ...compactThread, title: "Replacement snapshot" };
      const harness = yield* makeHarness({
        cached: compactThread,
        cachedActivityDetailMode: "compact",
        requestedActivityDetailMode: "compact",
        httpOutcomes: [
          { _tag: "TransientFailure", message: "old generation failed" },
          {
            _tag: "Found",
            snapshot: {
              snapshotSequence: CACHED_SNAPSHOT_SEQUENCE + 1,
              activityDetailMode: "compact",
              thread: refreshedThread,
            },
          },
        ],
      });
      expect(yield* Queue.take(harness.subscriptionAttempts)).toMatchObject({
        clientId: "initial",
        afterSequence: CACHED_SNAPSHOT_SEQUENCE,
      });
      yield* Queue.offer(harness.inputs, historicalActivityAppended());
      for (let spin = 0; spin < 100; spin += 1) {
        if ((yield* Ref.get(harness.loaderCalls)) >= 1) break;
        yield* Effect.yieldNow;
      }

      const replacementInputs = yield* Queue.unbounded<TestThreadInput>();
      const currentConnection = yield* SubscriptionRef.get(harness.supervisorState);
      yield* SubscriptionRef.set(harness.supervisorState, {
        ...currentConnection,
        phase: "connecting",
        stage: "synchronizing",
        generation: currentConnection.generation + 1,
      });
      yield* harness.replaceSessionUsing(replacementInputs, "replacement-refresh");
      yield* TestClock.adjust("51 millis");
      expect(yield* Queue.take(harness.subscriptionAttempts)).toEqual({
        clientId: "replacement-refresh",
        afterSequence: CACHED_SNAPSHOT_SEQUENCE,
      });
      yield* Queue.offer(replacementInputs, historicalActivityAppended());

      const recovered = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Replacement snapshot",
      );
      expect(Option.isNone(recovered.error)).toBe(true);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(2);
    }),
  );

  it.effect("ignores deferred Found and NotFound outcomes from an obsolete generation", () =>
    Effect.gen(function* () {
      for (const outcomeTag of ["Found", "NotFound"] as const) {
        const compactThread = compactThreadWithHistory();
        const deferred = yield* Deferred.make<ThreadSnapshotLoadOutcome>();
        const outcome: ThreadSnapshotLoadOutcome =
          outcomeTag === "Found"
            ? {
                _tag: "Found",
                snapshot: {
                  snapshotSequence: CACHED_SNAPSHOT_SEQUENCE + 1,
                  activityDetailMode: "compact",
                  thread: { ...compactThread, title: "Obsolete generation snapshot" },
                },
              }
            : { _tag: "NotFound" };
        const harness = yield* makeHarness({
          cached: compactThread,
          cachedActivityDetailMode: "compact",
          requestedActivityDetailMode: "compact",
          httpOutcomeEffects: [Deferred.await(deferred)],
        });
        expect(yield* Queue.take(harness.subscriptionAttempts)).toMatchObject({
          clientId: "initial",
          afterSequence: CACHED_SNAPSHOT_SEQUENCE,
        });
        yield* Queue.offer(harness.inputs, historicalActivityAppended());
        for (let spin = 0; spin < 100; spin += 1) {
          if ((yield* Ref.get(harness.loaderCalls)) >= 1) break;
          yield* Effect.yieldNow;
        }

        const replacementInputs = yield* Queue.unbounded<TestThreadInput>();
        const currentConnection = yield* SubscriptionRef.get(harness.supervisorState);
        yield* SubscriptionRef.set(harness.supervisorState, {
          ...currentConnection,
          phase: "connecting",
          stage: "synchronizing",
          generation: currentConnection.generation + 1,
        });
        yield* harness.replaceSessionUsing(replacementInputs, `replacement-deferred-${outcomeTag}`);
        yield* Deferred.succeed(deferred, outcome);
        yield* TestClock.adjust("51 millis");
        expect(yield* Queue.take(harness.subscriptionAttempts)).toEqual({
          clientId: `replacement-deferred-${outcomeTag}`,
          afterSequence: CACHED_SNAPSHOT_SEQUENCE,
        });

        const latest = yield* Ref.get(harness.latest);
        expect(latest.status).not.toBe("deleted");
        expect(Option.getOrThrow(latest.data).title).toBe(BASE_THREAD.title);
        expect(yield* Ref.get(harness.removedThreads)).toEqual([]);
      }
    }),
  );

  it.effect("treats refresh not-found as deletion without blocking a queued delete", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: compactThreadWithHistory(),
        cachedActivityDetailMode: "compact",
        requestedActivityDetailMode: "compact",
        httpOutcomes: [{ _tag: "NotFound" }],
      });
      yield* Queue.offer(harness.inputs, historicalActivityAppended());
      yield* Queue.offer(harness.inputs, deleted(CACHED_SNAPSHOT_SEQUENCE + 2));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "deleted" && Option.isNone(value.data),
      );
      for (let spin = 0; spin < 20; spin += 1) yield* Effect.yieldNow;

      expect(state.status).toBe("deleted");
      expect(yield* Ref.get(harness.loaderCalls)).toBe(1);
      expect(yield* Ref.get(harness.removedThreads)).toEqual([THREAD_ID]);
    }),
  );

  it.effect("reduces live events and persists the latest thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, titleUpdated("Live title"));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Live title",
      );
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;

      expect(Option.getOrThrow(state.data).title).toBe("Live title");
      expect((yield* Ref.get(harness.savedThreads)).at(-1)?.thread.title).toBe("Live title");
      expect((yield* Ref.get(harness.savedThreads)).at(-1)?.snapshotSequence).toBe(2);
    }),
  );

  it.effect("does not persist active thread snapshots during streaming or teardown", () =>
    Effect.gen(function* () {
      const savedThreads = yield* Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness({ cached: ACTIVE_THREAD });
          yield* awaitThreadState(
            harness.observed,
            (value) =>
              value.status === "live" &&
              Option.isSome(value.data) &&
              value.data.value.session?.status === "running",
          );

          yield* TestClock.adjust("500 millis");
          yield* Effect.yieldNow;

          expect(yield* Ref.get(harness.savedThreads)).toEqual([]);
          return harness.savedThreads;
        }),
      );

      expect(yield* Ref.get(savedThreads)).toEqual([]);
    }),
  );

  it.effect("seeds the thread from the HTTP snapshot and resumes live events", () =>
    Effect.gen(function* () {
      const httpThread: OrchestrationThread = {
        ...BASE_THREAD,
        title: "HTTP title",
      };
      const harness = yield* makeHarness({
        httpSnapshot: Option.some({
          snapshotSequence: 1,
          activityDetailMode: "full",
          thread: httpThread,
        }),
      });
      // No socket snapshot is pushed; only a live event arrives over the socket.
      // It can only be applied if the HTTP snapshot already seeded the thread.
      yield* Queue.offer(harness.inputs, titleUpdated("Live title", 2));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Live title",
      );

      expect(Option.getOrThrow(state.data).title).toBe("Live title");
      // Cold cache: the full snapshot was loaded over HTTP and the socket
      // resumed from that snapshot's sequence.
      expect(yield* Ref.get(harness.loaderCalls)).toBeGreaterThanOrEqual(1);
      expect((yield* Ref.get(harness.subscribeAfterSequences)).at(-1)).toBe(1);
    }),
  );

  it.effect("applies queued message events to live thread state", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, queuedMessage());

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          (value.data.value.queuedMessages ?? []).length === 1,
      );

      const thread = Option.getOrThrow(state.data);
      expect(thread.queuedMessages?.[0]?.messageId).toBe("message-queued-1");
      expect(thread.queuedMessages?.[0]?.text).toBe("Queued follow-up");
    }),
  );

  it.effect("ignores replayed thread events at or below the snapshot sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, titleUpdated("Replayed title", 1));
      yield* Queue.offer(harness.inputs, titleUpdated("Live title", 2));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Live title",
      );

      expect(Option.getOrThrow(state.data).title).toBe("Live title");
    }),
  );

  it.effect("removes cached data when the thread is deleted", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, deleted());

      const state = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "deleted",
      );

      expect(Option.isNone(state.data)).toBe(true);
      expect(yield* Ref.get(harness.removedThreads)).toEqual([THREAD_ID]);
    }),
  );

  it.effect("does not resurrect a deleted thread when the app returns to the foreground", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: BASE_THREAD,
        completionMarker: true,
        httpSnapshot: Option.some({
          snapshotSequence: 4,
          activityDetailMode: "full",
          thread: { ...BASE_THREAD, title: "Stale HTTP thread" },
        }),
      });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, deleted());
      yield* awaitThreadState(harness.observed, (value) => value.status === "deleted");

      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);
      yield* Queue.offer(harness.wakeups, "application-active");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }

      const latest = yield* Ref.get(harness.latest);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);
      expect(latest.status).toBe("deleted");
      expect(Option.isNone(latest.data)).toBe(true);
    }),
  );

  it.effect("preserves data after a domain failure and resumes on a replacement session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* Queue.offer(harness.inputs, new Error("stream failed"));

      const state = yield* awaitThreadState(harness.observed, (value) =>
        Option.isSome(value.error),
      );

      expect(Option.getOrThrow(state.data)).toEqual(BASE_THREAD);
      expect(Option.getOrThrow(state.error)).toBe("stream failed");
      expect(yield* Ref.get(harness.retryCount)).toBe(0);

      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...BASE_THREAD,
          title: "Recovered thread",
        }),
      );
      const recovered = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Recovered thread",
      );

      expect(Option.isNone(recovered.error)).toBe(true);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
    }),
  );

  it.effect("recovers from a transient domain failure without replacing the session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Queue.offer(harness.inputs, new Error("thread not found yet"));

      const failed = yield* awaitThreadState(harness.observed, (value) =>
        Option.isSome(value.error),
      );
      expect(Option.getOrThrow(failed.error)).toBe("thread not found yet");
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(1);

      yield* TestClock.adjust("250 millis");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...BASE_THREAD,
          title: "Materialized thread",
        }),
      );

      const recovered = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Materialized thread",
      );

      expect(Option.isNone(recovered.error)).toBe(true);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.retryCount)).toBe(0);
    }),
  );

  it.effect("does not overwrite a live snapshot when the supervisor becomes ready", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 1,
        generation: 0,
        lastFailure: null,
        retryAt: null,
      });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");

      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connected",
        stage: null,
        attempt: 1,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      });
      for (let index = 0; index < 10; index += 1) {
        yield* Effect.yieldNow;
      }

      expect((yield* Ref.get(harness.latest)).status).toBe("live");
    }),
  );

  it.effect("keeps replayed updates synchronizing until the completion marker arrives", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD, completionMarker: true });
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "synchronizing" && Option.isSome(value.data),
      );
      expect(yield* Ref.get(harness.lastRequestCompletionMarker)).toBe(true);

      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Caught-up title", CACHED_SNAPSHOT_SEQUENCE + 1),
      );
      const catchingUp = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "synchronizing" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Caught-up title",
      );
      expect(catchingUp.status).toBe("synchronizing");

      yield* Queue.offer(harness.inputs, synchronized());
      const live = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
      expect(Option.getOrThrow(live.data).title).toBe("Caught-up title");
    }),
  );

  it.effect("resumes replacement sessions from the latest applied sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD, completionMarker: true });
      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Latest title", CACHED_SNAPSHOT_SEQUENCE + 1),
      );
      yield* Queue.offer(harness.inputs, synchronized());
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Latest title",
      );

      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE + 1);
      expect((yield* Ref.get(harness.latest)).status).toBe("synchronizing");
    }),
  );

  it.effect("resubscribes on app foreground from the latest applied sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD, completionMarker: true });
      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Latest title", CACHED_SNAPSHOT_SEQUENCE + 1),
      );
      yield* Queue.offer(harness.inputs, synchronized());
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.title === "Latest title",
      );

      yield* Queue.offer(harness.wakeups, "application-active");
      const synchronizing = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "synchronizing" && Option.isSome(value.data),
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }

      expect(synchronizing.status).toBe("synchronizing");
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE + 1);
      expect(yield* Ref.get(harness.lastRequestCompletionMarker)).toBe(true);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);

      yield* Queue.offer(harness.inputs, synchronized());
      const live = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
      expect(Option.getOrThrow(live.data).title).toBe("Latest title");

      yield* Queue.offer(harness.wakeups, "application-active-probe");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 3) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(3);

      yield* Queue.offer(harness.wakeups, "application-active-reconnect");
      for (let attempt = 0; attempt < 10; attempt += 1) {
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(3);
    }),
  );
});
