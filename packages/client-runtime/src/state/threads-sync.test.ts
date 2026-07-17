import {
  EnvironmentId,
  EventId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
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
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import * as RpcSession from "../rpc/session.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
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
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

type TestThreadInput = OrchestrationThreadStreamItem | Error;

function testSession(client: WsRpcProtocolClient): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.never,
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
  readonly httpSnapshot?: Option.Option<OrchestrationThreadDetailSnapshot>;
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
  const subscribeAfterSequences = yield* Ref.make<ReadonlyArray<number | undefined>>([]);
  const savedThreads = yield* Ref.make<ReadonlyArray<OrchestrationThreadDetailSnapshot>>([]);
  const removedThreads = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
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
      [ORCHESTRATION_WS_METHODS.subscribeThread]: (input: { readonly afterSequence?: number }) =>
        Stream.unwrap(
          Ref.updateAndGet(subscriptionCount, (count) => count + 1).pipe(
            Effect.andThen(
              Ref.update(subscribeAfterSequences, (sequences) => [
                ...sequences,
                input.afterSequence,
              ]),
            ),
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
    Option.some(testSession(client)),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
    Option.some(PREPARED),
  );
  const snapshotLoader = ThreadSnapshotLoader.of({
    load: (_prepared, threadId) =>
      Ref.update(loaderCalls, (count) => count + 1).pipe(
        Effect.as(
          threadId === THREAD_ID
            ? (options?.httpSnapshot ?? Option.none<OrchestrationThreadDetailSnapshot>())
            : Option.none<OrchestrationThreadDetailSnapshot>(),
        ),
      ),
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
    clear: () => Effect.void,
  });
  const threadState = yield* makeEnvironmentThreadState(THREAD_ID).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
    Effect.provideService(ThreadSnapshotLoader, snapshotLoader),
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
    subscribeAfterSequences,
    supervisorState,
    supervisorSession,
    savedThreads,
    removedThreads,
    replaceSession: SubscriptionRef.set(supervisorSession, Option.some(testSession(client))),
    replaceSessionUsing: (queue: Queue.Queue<TestThreadInput>, clientId = "replacement") =>
      SubscriptionRef.set(supervisorSession, Option.some(testSession(clientFor(queue, clientId)))),
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
    thread,
  },
});

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

const deleted = (): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make("event-deleted"),
    sequence: 3,
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

describe("EnvironmentThreads", () => {
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

  it.effect("seeds the thread from the HTTP snapshot and resumes live events", () =>
    Effect.gen(function* () {
      const httpThread: OrchestrationThread = {
        ...BASE_THREAD,
        title: "HTTP title",
      };
      const harness = yield* makeHarness({
        httpSnapshot: Option.some({
          snapshotSequence: 1,
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
});
