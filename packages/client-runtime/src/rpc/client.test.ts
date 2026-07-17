import {
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  ThreadId,
  type OrchestrationThreadStreamItem,
  type RelayClientInstallProgressEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/unstable/rpc";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  EnvironmentRpcRequestObserver,
  request,
  runStream,
  subscribe,
  subscribeWithSessionDynamic,
} from "./client.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const INSTALL_CHECKING: RelayClientInstallProgressEvent = {
  type: "progress",
  stage: "checking",
};
const INSTALL_DOWNLOADING: RelayClientInstallProgressEvent = {
  type: "progress",
  stage: "downloading",
};

type TestThreadStreamItem = OrchestrationThreadStreamItem | Error;

const synchronized: OrchestrationThreadStreamItem = { kind: "synchronized" };

function testThreadStream(queue: Queue.Queue<TestThreadStreamItem>) {
  return Stream.fromQueue(queue).pipe(
    Stream.mapEffect((item) => (item instanceof Error ? Effect.fail(item) : Effect.succeed(item))),
  );
}

function threadQueue(
  queues: ReadonlyMap<ThreadId, Queue.Queue<TestThreadStreamItem>>,
  threadId: ThreadId | undefined,
): Queue.Queue<TestThreadStreamItem> {
  const queue = threadId === undefined ? undefined : queues.get(threadId);
  if (queue === undefined)
    throw new Error(`Missing test queue for ${threadId ?? "unknown thread"}.`);
  return queue;
}

const threadCatchUpAdmission = {
  group: "test-thread-detail-catch-up",
  maxConcurrent: 3,
  releaseWhen: (item: OrchestrationThreadStreamItem) => item.kind === "synchronized",
};

function session(client: WsRpcProtocolClient): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

const makeHarness = Effect.fn("TestEnvironmentRpc.makeHarness")(function* () {
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE);
  const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.none(),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none());
  const retryCount = yield* Ref.make(0);
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state,
    session: activeSession,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Ref.update(retryCount, (count) => count + 1),
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  return {
    activeSession,
    retryCount,
    supervisor,
  };
});

describe("environment RPC", () => {
  it.effect("bounds catch-up admission while keeping synchronized subscriptions live", () =>
    Effect.gen(function* () {
      const ids = Array.from({ length: 8 }, (_, index) => ThreadId.make(`thread-${index}`));
      const queues = new Map(
        yield* Effect.forEach(ids, (id) =>
          Queue.unbounded<TestThreadStreamItem>().pipe(Effect.map((queue) => [id, queue] as const)),
        ),
      );
      const starts = yield* Queue.unbounded<ThreadId>();
      const active = yield* Ref.make(0);
      const client = {
        [ORCHESTRATION_WS_METHODS.subscribeThread]: (input: { readonly threadId: ThreadId }) =>
          Stream.unwrap(
            Effect.gen(function* () {
              yield* Ref.update(active, (count) => count + 1);
              yield* Queue.offer(starts, input.threadId);
              return testThreadStream(threadQueue(queues, input.threadId)).pipe(
                Stream.ensuring(Ref.update(active, (count) => count - 1)),
              );
            }),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));

      const fibers = yield* Effect.forEach(ids, (threadId) =>
        subscribeWithSessionDynamic(
          ORCHESTRATION_WS_METHODS.subscribeThread,
          () => Effect.succeed({ threadId, includeSynchronizationItems: true }),
          { admission: threadCatchUpAdmission },
        ).pipe(
          Stream.runDrain,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        ),
      );

      const firstWave = yield* Effect.all([
        Queue.take(starts),
        Queue.take(starts),
        Queue.take(starts),
      ]);
      expect(Option.isNone(yield* Queue.poll(starts))).toBe(true);
      yield* Effect.forEach(firstWave, (id) => Queue.offer(threadQueue(queues, id), synchronized), {
        discard: true,
      });
      const secondWave = yield* Effect.all([
        Queue.take(starts),
        Queue.take(starts),
        Queue.take(starts),
      ]);
      expect(Option.isNone(yield* Queue.poll(starts))).toBe(true);
      yield* Effect.forEach(
        secondWave,
        (id) => Queue.offer(threadQueue(queues, id), synchronized),
        {
          discard: true,
        },
      );
      const thirdWave = yield* Effect.all([Queue.take(starts), Queue.take(starts)]);
      expect(Option.isNone(yield* Queue.poll(starts))).toBe(true);
      yield* Effect.forEach(thirdWave, (id) => Queue.offer(threadQueue(queues, id), synchronized), {
        discard: true,
      });
      expect(new Set([...firstWave, ...secondWave, ...thirdWave])).toEqual(new Set(ids));
      expect(yield* Ref.get(active)).toBe(8);
      yield* Effect.forEach(fibers, Fiber.interrupt, { discard: true });
    }),
  );

  it.effect("releases catch-up permits after failure and interruption", () =>
    Effect.gen(function* () {
      const ids = Array.from({ length: 5 }, (_, index) => ThreadId.make(`release-${index}`));
      const queues = new Map(
        yield* Effect.forEach(ids, (id) =>
          Queue.unbounded<TestThreadStreamItem>().pipe(Effect.map((queue) => [id, queue] as const)),
        ),
      );
      const starts = yield* Queue.unbounded<ThreadId>();
      const client = {
        [ORCHESTRATION_WS_METHODS.subscribeThread]: (input: { readonly threadId: ThreadId }) =>
          Stream.fromEffect(Queue.offer(starts, input.threadId)).pipe(
            Stream.drain,
            Stream.concat(testThreadStream(threadQueue(queues, input.threadId))),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const fibers = yield* Effect.forEach(ids, (threadId) =>
        subscribeWithSessionDynamic(
          ORCHESTRATION_WS_METHODS.subscribeThread,
          () => Effect.succeed({ threadId, includeSynchronizationItems: true }),
          { admission: threadCatchUpAdmission },
        ).pipe(
          Stream.runDrain,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        ),
      );

      const firstWave = yield* Effect.all([
        Queue.take(starts),
        Queue.take(starts),
        Queue.take(starts),
      ]);
      expect(firstWave).toEqual(ids.slice(0, 3));
      yield* Queue.offer(threadQueue(queues, firstWave[0]), new Error("catch-up failed"));
      expect(yield* Queue.take(starts)).toBe(ids[3]);
      const interruptedFiber = fibers[1];
      if (interruptedFiber === undefined) return yield* Effect.die("Missing subscription fiber.");
      yield* Fiber.interrupt(interruptedFiber);
      expect(yield* Queue.take(starts)).toBe(ids[4]);
      yield* Effect.forEach(fibers, Fiber.interrupt, { discard: true });
    }),
  );

  it.effect("uses a fresh admission gate for a replacement session", () =>
    Effect.gen(function* () {
      const ids = Array.from({ length: 4 }, (_, index) => ThreadId.make(`session-${index}`));
      const firstStarts = yield* Queue.unbounded<ThreadId>();
      const secondStarts = yield* Queue.unbounded<ThreadId>();
      const makeClient = (starts: Queue.Queue<ThreadId>) =>
        ({
          [ORCHESTRATION_WS_METHODS.subscribeThread]: (input: { readonly threadId: ThreadId }) =>
            Stream.fromEffect(Queue.offer(starts, input.threadId)).pipe(
              Stream.drain,
              Stream.concat(Stream.never),
            ),
        }) as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(makeClient(firstStarts))));
      const fibers = yield* Effect.forEach(ids, (threadId) =>
        subscribeWithSessionDynamic(
          ORCHESTRATION_WS_METHODS.subscribeThread,
          () => Effect.succeed({ threadId, includeSynchronizationItems: true }),
          { admission: threadCatchUpAdmission },
        ).pipe(
          Stream.runDrain,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        ),
      );

      yield* Effect.all([
        Queue.take(firstStarts),
        Queue.take(firstStarts),
        Queue.take(firstStarts),
      ]);
      expect(Option.isNone(yield* Queue.poll(firstStarts))).toBe(true);
      yield* SubscriptionRef.set(activeSession, Option.some(session(makeClient(secondStarts))));
      const replacementWave = yield* Effect.all([
        Queue.take(secondStarts),
        Queue.take(secondStarts),
        Queue.take(secondStarts),
      ]);
      expect(new Set(replacementWave).size).toBe(3);
      expect(Option.isNone(yield* Queue.poll(secondStarts))).toBe(true);
      yield* Effect.forEach(fibers, Fiber.interrupt, { discard: true });
    }),
  );

  it.effect("rejects invalid admission limits before starting a subscription", () =>
    Effect.gen(function* () {
      const client = {
        [ORCHESTRATION_WS_METHODS.subscribeThread]: () => Stream.never,
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));

      for (const maxConcurrent of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
        const exit = yield* subscribeWithSessionDynamic(
          ORCHESTRATION_WS_METHODS.subscribeThread,
          () => Effect.succeed({ threadId: ThreadId.make("invalid-limit") }),
          {
            admission: {
              ...threadCatchUpAdmission,
              maxConcurrent,
            },
          },
        ).pipe(
          Stream.runDrain,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain(
            "Subscription admission maxConcurrent must be a positive safe integer",
          );
        }
      }
    }),
  );

  it.effect("rejects conflicting limits for one session admission group", () =>
    Effect.gen(function* () {
      const starts = yield* Queue.unbounded<ThreadId>();
      const client = {
        [ORCHESTRATION_WS_METHODS.subscribeThread]: (input: { readonly threadId: ThreadId }) =>
          Stream.fromEffect(Queue.offer(starts, input.threadId)).pipe(
            Stream.drain,
            Stream.concat(Stream.never),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const firstFiber = yield* subscribeWithSessionDynamic(
        ORCHESTRATION_WS_METHODS.subscribeThread,
        () => Effect.succeed({ threadId: ThreadId.make("limit-one") }),
        { admission: { ...threadCatchUpAdmission, maxConcurrent: 1 } },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Queue.take(starts);

      const exit = yield* subscribeWithSessionDynamic(
        ORCHESTRATION_WS_METHODS.subscribeThread,
        () => Effect.succeed({ threadId: ThreadId.make("limit-two") }),
        { admission: { ...threadCatchUpAdmission, maxConcurrent: 2 } },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain(
          'group "test-thread-detail-catch-up" already uses maxConcurrent 1; received conflicting 2',
        );
      }
      yield* Fiber.interrupt(firstFiber);
    }),
  );

  it.effect("releases admission before an expected-failure retry becomes live", () =>
    Effect.gen(function* () {
      const domainError = new Error("retry catch-up");
      const attemptCount = yield* Ref.make(0);
      const active = yield* Ref.make(0);
      const attempts = yield* Queue.unbounded<{
        readonly attempt: number;
        readonly events: Queue.Queue<TestThreadStreamItem>;
      }>();
      const failures = yield* Queue.unbounded<void>();
      const observed = yield* Queue.unbounded<OrchestrationThreadStreamItem>();
      const client = {
        [ORCHESTRATION_WS_METHODS.subscribeThread]: () =>
          Stream.unwrap(
            Effect.gen(function* () {
              const attempt = yield* Ref.updateAndGet(attemptCount, (count) => count + 1);
              const events = yield* Queue.unbounded<TestThreadStreamItem>();
              yield* Ref.update(active, (count) => count + 1);
              yield* Queue.offer(attempts, { attempt, events });
              const stream = attempt === 1 ? Stream.fail(domainError) : testThreadStream(events);
              return stream.pipe(Stream.ensuring(Ref.update(active, (count) => count - 1)));
            }),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const fiber = yield* subscribeWithSessionDynamic(
        ORCHESTRATION_WS_METHODS.subscribeThread,
        () => Effect.succeed({ threadId: ThreadId.make("retry-live") }),
        {
          admission: { ...threadCatchUpAdmission, maxConcurrent: 1 },
          onExpectedFailure: () => Queue.offer(failures, undefined),
          retryExpectedFailureAfter: "100 millis",
        },
      ).pipe(
        Stream.runForEach((item) => Queue.offer(observed, item.value)),
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );

      expect((yield* Queue.take(attempts)).attempt).toBe(1);
      yield* Queue.take(failures);
      expect(yield* Ref.get(active)).toBe(0);
      yield* TestClock.adjust("100 millis");
      const retry = yield* Queue.take(attempts);
      expect(retry.attempt).toBe(2);
      yield* Queue.offer(retry.events, synchronized);
      expect(yield* Queue.take(observed)).toEqual(synchronized);
      expect(yield* Ref.get(active)).toBe(1);
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("cancels a queued fourth waiter without granting a ghost permit", () =>
    Effect.gen(function* () {
      const ids = Array.from({ length: 5 }, (_, index) => ThreadId.make(`cancel-${index}`));
      const queues = new Map(
        yield* Effect.forEach(ids, (id) =>
          Queue.unbounded<TestThreadStreamItem>().pipe(Effect.map((queue) => [id, queue] as const)),
        ),
      );
      const starts = yield* Queue.unbounded<ThreadId>();
      const attempts = yield* Queue.unbounded<ThreadId>();
      const client = {
        [ORCHESTRATION_WS_METHODS.subscribeThread]: (input: { readonly threadId: ThreadId }) =>
          Stream.fromEffect(Queue.offer(starts, input.threadId)).pipe(
            Stream.drain,
            Stream.concat(testThreadStream(threadQueue(queues, input.threadId))),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const fibers = yield* Effect.forEach(ids, (threadId) =>
        subscribeWithSessionDynamic(
          ORCHESTRATION_WS_METHODS.subscribeThread,
          () => Queue.offer(attempts, threadId).pipe(Effect.as({ threadId })),
          { admission: threadCatchUpAdmission },
        ).pipe(
          Stream.runDrain,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        ),
      );
      const firstWave = yield* Effect.all([
        Queue.take(starts),
        Queue.take(starts),
        Queue.take(starts),
      ]);
      expect(firstWave).toEqual(ids.slice(0, 3));
      const attempted = yield* Effect.all([
        Queue.take(attempts),
        Queue.take(attempts),
        Queue.take(attempts),
        Queue.take(attempts),
        Queue.take(attempts),
      ]);
      expect(attempted).toEqual(ids);
      const fourthFiber = fibers[3];
      if (fourthFiber === undefined) return yield* Effect.die("Missing fourth waiter.");
      yield* Fiber.interrupt(fourthFiber);
      expect(Option.isNone(yield* Queue.poll(starts))).toBe(true);
      yield* Queue.offer(threadQueue(queues, firstWave[0]), synchronized);
      expect(yield* Queue.take(starts)).toBe(ids[4]);
      expect(Option.isNone(yield* Queue.poll(starts))).toBe(true);
      yield* Effect.forEach(fibers, Fiber.interrupt, { discard: true });
    }),
  );

  it.effect("releases exactly once when synchronization is duplicated", () =>
    Effect.gen(function* () {
      const ids = Array.from({ length: 3 }, (_, index) => ThreadId.make(`duplicate-${index}`));
      const queues = new Map(
        yield* Effect.forEach(ids, (id) =>
          Queue.unbounded<TestThreadStreamItem>().pipe(Effect.map((queue) => [id, queue] as const)),
        ),
      );
      const starts = yield* Queue.unbounded<ThreadId>();
      const consumed = yield* Queue.unbounded<{
        readonly threadId: ThreadId;
        readonly item: OrchestrationThreadStreamItem;
      }>();
      const client = {
        [ORCHESTRATION_WS_METHODS.subscribeThread]: (input: { readonly threadId: ThreadId }) =>
          Stream.fromEffect(Queue.offer(starts, input.threadId)).pipe(
            Stream.drain,
            Stream.concat(testThreadStream(threadQueue(queues, input.threadId))),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const fibers = yield* Effect.forEach(ids, (threadId) =>
        subscribeWithSessionDynamic(
          ORCHESTRATION_WS_METHODS.subscribeThread,
          () => Effect.succeed({ threadId }),
          { admission: { ...threadCatchUpAdmission, maxConcurrent: 1 } },
        ).pipe(
          Stream.runForEach((item) => Queue.offer(consumed, { threadId, item: item.value })),
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        ),
      );

      expect(yield* Queue.take(starts)).toBe(ids[0]);
      yield* Queue.offer(threadQueue(queues, ids[0]), synchronized);
      yield* Queue.offer(threadQueue(queues, ids[0]), synchronized);
      expect(yield* Queue.take(starts)).toBe(ids[1]);
      expect(yield* Effect.all([Queue.take(consumed), Queue.take(consumed)])).toEqual([
        { threadId: ids[0], item: synchronized },
        { threadId: ids[0], item: synchronized },
      ]);
      expect(Option.isNone(yield* Queue.poll(starts))).toBe(true);
      yield* Queue.offer(threadQueue(queues, ids[1]), synchronized);
      expect(yield* Queue.take(starts)).toBe(ids[2]);
      yield* Effect.forEach(fibers, Fiber.interrupt, { discard: true });
    }),
  );

  it.effect("observes unary requests until they complete", () =>
    Effect.gen(function* () {
      const observations: string[] = [];
      const client = {
        [WS_METHODS.cloudGetRelayClientStatus]: () =>
          Effect.succeed({ status: "available", version: "2026.6.0" }),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));

      const result = yield* request(WS_METHODS.cloudGetRelayClientStatus, {}).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(
          EnvironmentRpcRequestObserver,
          EnvironmentRpcRequestObserver.of({
            observe: ({ environmentId, method }) =>
              Effect.sync(() => {
                observations.push(`start:${environmentId}:${method}`);
                return Effect.sync(() => {
                  observations.push(`finish:${environmentId}:${method}`);
                });
              }),
          }),
        ),
      );

      expect(result).toEqual({ status: "available", version: "2026.6.0" });
      expect(observations).toEqual([
        `start:${TARGET.environmentId}:${WS_METHODS.cloudGetRelayClientStatus}`,
        `finish:${TARGET.environmentId}:${WS_METHODS.cloudGetRelayClientStatus}`,
      ]);
    }),
  );

  it.effect("binds finite streaming commands to one active session", () =>
    Effect.gen(function* () {
      const firstEvents = yield* Queue.unbounded<RelayClientInstallProgressEvent>();
      const secondEvents = yield* Queue.unbounded<RelayClientInstallProgressEvent>();
      const firstClient = {
        [WS_METHODS.cloudInstallRelayClient]: () => Stream.fromQueue(firstEvents),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.cloudInstallRelayClient]: () => Stream.fromQueue(secondEvents),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      const resultFiber = yield* runStream(WS_METHODS.cloudInstallRelayClient, {}).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      yield* Queue.offer(firstEvents, INSTALL_CHECKING);
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      yield* Queue.offer(secondEvents, INSTALL_DOWNLOADING);
      yield* Queue.offer(firstEvents, INSTALL_DOWNLOADING);

      expect(yield* Fiber.join(resultFiber)).toEqual([INSTALL_CHECKING, INSTALL_DOWNLOADING]);
    }),
  );

  it.effect("switches durable subscriptions when the supervisor replaces the session", () =>
    Effect.gen(function* () {
      const subscriptions: string[] = [];
      const firstClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("first");
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("second");
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();
      const awaitSubscriptions = Effect.fn("TestEnvironmentRpc.awaitSubscriptions")(function* (
        count: number,
      ) {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (subscriptions.length >= count) {
            return;
          }
          yield* Effect.yieldNow;
        }
        return yield* Effect.die(new Error(`Expected ${count} durable subscriptions.`));
      });

      const subscriptionFiber = yield* subscribe(WS_METHODS.subscribeTerminalEvents, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      yield* awaitSubscriptions(1);
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      yield* awaitSubscriptions(2);
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("keeps durable subscriptions alive across a transport failure and new session", () =>
    Effect.gen(function* () {
      const subscriptions: string[] = [];
      const firstClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("first");
          return Stream.fail(
            new RpcClientError.RpcClientError({
              reason: new RpcClientError.RpcClientDefect({
                message: "socket closed",
                cause: new Error("socket closed"),
              }),
            }),
          );
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("second");
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      const subscriptionFiber = yield* subscribe(WS_METHODS.subscribeTerminalEvents, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      for (let attempt = 0; attempt < 100 && subscriptions.length < 1; attempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* SubscriptionRef.set(activeSession, Option.none());
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));

      for (let attempt = 0; attempt < 100 && subscriptions.length < 2; attempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("surfaces domain subscription failures without reconnecting", () =>
    Effect.gen(function* () {
      const domainError = new Error("terminal subscription rejected");
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () => Stream.fail(domainError),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const error = yield* subscribe(WS_METHODS.subscribeTerminalEvents, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
      );

      expect(error).toBe(domainError);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("keeps handled domain failures dormant until a replacement session arrives", () =>
    Effect.gen(function* () {
      const domainError = new Error("terminal subscription rejected");
      const subscriptions: string[] = [];
      const observedFailures: Error[] = [];
      const firstClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("first");
          return Stream.fail(domainError);
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("second");
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      const subscriptionFiber = yield* subscribe(
        WS_METHODS.subscribeTerminalEvents,
        {},
        {
          onExpectedFailure: (cause) =>
            Effect.sync(() => {
              observedFailures.push(Cause.squash(cause) as Error);
            }),
        },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      for (let attempt = 0; attempt < 100 && observedFailures.length < 1; attempt += 1) {
        yield* Effect.yieldNow;
      }

      expect(subscriptions).toEqual(["first"]);
      expect(observedFailures).toEqual([domainError]);

      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      for (let attempt = 0; attempt < 100 && subscriptions.length < 2; attempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("retries handled domain failures within the same session when configured", () =>
    Effect.gen(function* () {
      const domainError = new Error("thread not found yet");
      const subscriptionCount = yield* Ref.make(0);
      const expectedFailureCount = yield* Ref.make(0);
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () =>
          Stream.unwrap(
            Ref.getAndUpdate(subscriptionCount, (count) => count + 1).pipe(
              Effect.map((count) => (count === 0 ? Stream.fail(domainError) : Stream.never)),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const subscriptionFiber = yield* subscribe(
        WS_METHODS.subscribeTerminalEvents,
        {},
        {
          onExpectedFailure: () => Ref.update(expectedFailureCount, (count) => count + 1),
          retryExpectedFailureAfter: "100 millis",
        },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(expectedFailureCount)) >= 1) {
          break;
        }
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(subscriptionCount)).toBe(1);
      expect(yield* Ref.get(expectedFailureCount)).toBe(1);

      yield* TestClock.adjust("100 millis");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(subscriptionCount)) >= 2) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* Fiber.interrupt(subscriptionFiber);

      expect(yield* Ref.get(subscriptionCount)).toBe(2);
      expect(yield* Ref.get(expectedFailureCount)).toBe(1);
    }),
  );

  it.effect("does not classify subscription defects as expected failures", () =>
    Effect.gen(function* () {
      const defect = new Error("subscription invariant failed");
      let expectedFailureCount = 0;
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () => Stream.die(defect),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const exit = yield* subscribe(
        WS_METHODS.subscribeTerminalEvents,
        {},
        {
          onExpectedFailure: () =>
            Effect.sync(() => {
              expectedFailureCount += 1;
            }),
        },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true);
      }
      expect(expectedFailureCount).toBe(0);
    }),
  );
});
