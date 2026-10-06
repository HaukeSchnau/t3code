import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  PreviewTabId,
  ThreadId,
  type OrchestrationV2SubscribeThreadInput,
  type OrchestrationV2ThreadStreamItem,
  type PreviewAutomationStreamEvent,
  type RelayClientInstallProgressEvent,
  type ServerConfigStreamEvent,
  type ServerLifecycleStreamEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
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
  subscribeDynamic,
  subscribeDynamicWithSession,
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

function session(client: WsRpcProtocolClient): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
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
  it.effect("registers a fresh preview host after completion without replaying requests", () =>
    Effect.gen(function* () {
      const firstCompleted = yield* Deferred.make<void>();
      const reconnected = yield* Deferred.make<void>();
      const requests: string[] = [];
      const connections: string[] = [];
      let attempts = 0;
      const client = {
        [WS_METHODS.previewAutomationConnect]: () =>
          Stream.suspend(() => {
            attempts += 1;
            const connected: PreviewAutomationStreamEvent = {
              type: "connected",
              connectionId: `connection-${attempts}`,
            };
            return attempts === 1
              ? Stream.make(connected, {
                  type: "request",
                  connectionId: connected.connectionId,
                  request: {
                    requestId: "timed-out-action",
                    operation: "click",
                    threadId: ThreadId.make("thread-1"),
                    tabId: PreviewTabId.make("tab-1"),
                    input: {},
                    timeoutMs: 1_000,
                  },
                } satisfies PreviewAutomationStreamEvent).pipe(
                  Stream.ensuring(Deferred.succeed(firstCompleted, undefined)),
                )
              : Stream.succeed(connected).pipe(Stream.concat(Stream.never));
          }),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const consumer = yield* subscribe(WS_METHODS.previewAutomationConnect, {
        clientId: "preview-host",
        environmentId: TARGET.environmentId,
      }).pipe(
        Stream.runForEach((event) => {
          if (event.type === "request") {
            requests.push(event.request.requestId);
            return Effect.void;
          }
          connections.push(event.connectionId);
          return connections.length === 2 ? Deferred.succeed(reconnected, undefined) : Effect.void;
        }),
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Deferred.await(firstCompleted);
      yield* TestClock.adjust(999);
      expect(attempts).toBe(1);
      yield* TestClock.adjust(1);
      yield* Deferred.await(reconnected);
      expect(attempts).toBe(2);
      expect(connections).toEqual(["connection-1", "connection-2"]);
      expect(requests).toEqual(["timed-out-action"]);
      yield* Fiber.interrupt(consumer);
    }),
  );

  it.effect("does not re-register an unmounted preview host during the recovery delay", () =>
    Effect.gen(function* () {
      const completed = yield* Deferred.make<void>();
      let attempts = 0;
      const client = {
        [WS_METHODS.previewAutomationConnect]: () =>
          Stream.suspend(() => {
            attempts += 1;
            return Stream.empty.pipe(Stream.ensuring(Deferred.succeed(completed, undefined)));
          }),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const consumer = yield* subscribe(WS_METHODS.previewAutomationConnect, {
        clientId: "preview-host",
        environmentId: TARGET.environmentId,
      }).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Deferred.await(completed);
      yield* Fiber.interrupt(consumer);
      yield* TestClock.adjust(10_000);
      expect(attempts).toBe(1);
    }),
  );

  it.effect.each(["completion", "transport failure"] as const)(
    "keeps preview recovery tied to the active session after %s",
    (reason) =>
      Effect.gen(function* () {
        const completed = yield* Deferred.make<void>();
        const nextConnected = yield* Deferred.make<void>();
        let oldAttempts = 0;
        let nextAttempts = 0;
        const firstClient = {
          [WS_METHODS.previewAutomationConnect]: () =>
            Stream.suspend(() => {
              oldAttempts += 1;
              return (
                reason === "completion"
                  ? Stream.empty
                  : Stream.fail(
                      new RpcClientError.RpcClientError({
                        reason: new RpcClientError.RpcClientDefect({
                          message: "socket closed",
                          cause: new Error("socket closed"),
                        }),
                      }),
                    )
              ).pipe(Stream.ensuring(Deferred.succeed(completed, undefined)));
            }),
        } as unknown as WsRpcProtocolClient;
        const nextClient = {
          [WS_METHODS.previewAutomationConnect]: () =>
            Stream.suspend(() => {
              nextAttempts += 1;
              return Stream.fromEffect(Deferred.succeed(nextConnected, undefined)).pipe(
                Stream.drain,
                Stream.concat(Stream.never),
              );
            }),
        } as unknown as WsRpcProtocolClient;
        const { activeSession, supervisor } = yield* makeHarness();
        yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
        const consumer = yield* subscribe(WS_METHODS.previewAutomationConnect, {
          clientId: "preview-host",
          environmentId: TARGET.environmentId,
        }).pipe(
          Stream.runDrain,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        );
        yield* Deferred.await(completed);
        if (reason === "transport failure") {
          yield* TestClock.adjust(10_000);
          expect(oldAttempts).toBe(1);
        }
        yield* SubscriptionRef.set(activeSession, Option.some(session(nextClient)));
        yield* Deferred.await(nextConnected);
        yield* TestClock.adjust(10_000);
        expect(oldAttempts).toBe(1);
        expect(nextAttempts).toBe(1);
        yield* Fiber.interrupt(consumer);
      }),
  );

  it.effect("reuses the session config stream instead of opening a duplicate subscription", () =>
    Effect.gen(function* () {
      const event: ServerConfigStreamEvent = {
        version: 1,
        type: "settingsUpdated",
        payload: { settings: DEFAULT_SERVER_SETTINGS },
      };
      let duplicateSubscriptions = 0;
      const client = {
        [WS_METHODS.subscribeServerConfig]: () => {
          duplicateSubscriptions += 1;
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(
        activeSession,
        Option.some({
          ...session(client),
          subscribeServerConfig: () => Stream.succeed(event),
        }),
      );

      const received = yield* subscribe(WS_METHODS.subscribeServerConfig, {}).pipe(
        Stream.runHead,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      );

      expect(received).toEqual(Option.some(event));
      expect(duplicateSubscriptions).toBe(0);
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

  it.effect("keeps the producer session on an old value buffered across a session switch", () =>
    Effect.gen(function* () {
      const firstSubscribed = yield* Deferred.make<void>();
      const secondSubscribed = yield* Deferred.make<void>();
      const firstValueBlocked = yield* Deferred.make<void>();
      const releaseFirstValue = yield* Deferred.make<void>();
      const firstValue = { source: "first", index: 1 } as unknown as ServerLifecycleStreamEvent;
      const bufferedFirstValue = {
        source: "first",
        index: 2,
      } as unknown as ServerLifecycleStreamEvent;
      const secondValue = { source: "second", index: 1 } as unknown as ServerLifecycleStreamEvent;
      const firstClient = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.fromEffect(Deferred.succeed(firstSubscribed, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.fromIterable([firstValue, bufferedFirstValue])),
            Stream.concat(Stream.never),
          ),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.fromEffect(Deferred.succeed(secondSubscribed, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.make(secondValue)),
            Stream.concat(Stream.never),
          ),
      } as unknown as WsRpcProtocolClient;
      const firstSession = session(firstClient);
      const secondSession = session(secondClient);
      const { activeSession, supervisor } = yield* makeHarness();

      const resultFiber = yield* subscribeDynamicWithSession(
        WS_METHODS.subscribeServerLifecycle,
        () => Effect.succeed({}),
      ).pipe(
        Stream.mapEffect(([producerSession, value]) =>
          value === firstValue
            ? Deferred.succeed(firstValueBlocked, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirstValue)),
                Effect.as([producerSession, value] as const),
              )
            : Effect.succeed([producerSession, value] as const),
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );

      yield* SubscriptionRef.set(activeSession, Option.some(firstSession));
      yield* Deferred.await(firstSubscribed);
      yield* Deferred.await(firstValueBlocked);
      yield* SubscriptionRef.set(activeSession, Option.some(secondSession));
      yield* Deferred.await(secondSubscribed);
      yield* Deferred.succeed(releaseFirstValue, undefined);

      const result = yield* Fiber.join(resultFiber);
      expect(result).toEqual([
        [firstSession, firstValue],
        [firstSession, bufferedFirstValue],
        [secondSession, secondValue],
      ]);
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

  it.effect.each(["input", "stream"] as const)(
    "does not classify %s subscription defects as expected failures",
    (where) =>
      Effect.gen(function* () {
        const defect = new Error("subscription invariant failed");
        let expectedFailureCount = 0;
        let inputs = 0;
        let streams = 0;
        const observedDefects: unknown[] = [];
        const client = {
          [WS_METHODS.subscribeTerminalEvents]: () => {
            streams += 1;
            return where === "stream" ? Stream.die(defect) : Stream.never;
          },
        } as unknown as WsRpcProtocolClient;
        const { activeSession, supervisor } = yield* makeHarness();

        yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
        const exit = yield* subscribeDynamicWithSession(
          WS_METHODS.subscribeTerminalEvents,
          () =>
            Effect.sync(() => {
              inputs += 1;
            }).pipe(Effect.andThen(where === "input" ? Effect.die(defect) : Effect.succeed({}))),
          {
            onDefect: (cause) =>
              Effect.sync(() => {
                observedDefects.push(Cause.squash(cause));
              }),
            onExpectedFailure: () =>
              Effect.sync(() => {
                expectedFailureCount += 1;
              }),
            retryExpectedFailureAfter: "250 millis",
          },
        ).pipe(
          Stream.runDrain,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(true);
          expect(Cause.squash(exit.cause)).toBe(defect);
        }
        expect(inputs).toBe(1);
        expect(streams).toBe(where === "input" ? 0 : 1);
        expect(expectedFailureCount).toBe(0);
        expect(observedDefects).toEqual([defect]);
      }),
  );

  it.effect("reports an initializer defect once after an expected failure retries", () =>
    Effect.gen(function* () {
      const defect = new Error("Synthetic retry initializer defect");
      const expectedFailure = yield* Deferred.make<void>();
      const observations: string[] = [];
      const observedDefects: unknown[] = [];
      let inputs = 0;
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          observations.push("stream");
          return Stream.fail(new Error("subscription not ready"));
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const fiber = yield* subscribeDynamicWithSession(
        WS_METHODS.subscribeTerminalEvents,
        () =>
          Effect.sync(() => {
            inputs += 1;
            observations.push(`input ${inputs}`);
            return inputs;
          }).pipe(
            Effect.flatMap((attempt) => (attempt === 1 ? Effect.succeed({}) : Effect.die(defect))),
          ),
        {
          onDefect: (cause) =>
            Effect.sync(() => {
              observations.push("defect");
              observedDefects.push(Cause.squash(cause));
            }),
          onExpectedFailure: () =>
            Effect.sync(() => {
              observations.push("expected failure");
            }).pipe(Effect.andThen(Deferred.succeed(expectedFailure, undefined)), Effect.asVoid),
          retryExpectedFailureAfter: "250 millis",
        },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.exit,
        Effect.forkChild,
      );
      yield* Deferred.await(expectedFailure);
      yield* TestClock.adjust("250 millis");
      const exit = yield* Fiber.join(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true);
        expect(Cause.squash(exit.cause)).toBe(defect);
      }
      expect(observations).toEqual(["input 1", "stream", "expected failure", "input 2", "defect"]);
      expect(observedDefects).toEqual([defect]);
    }),
  );
});

type TestThreadStreamItem = OrchestrationV2ThreadStreamItem | Error;
type ThreadSubscriptionOptions = NonNullable<
  Parameters<typeof subscribeDynamic<typeof ORCHESTRATION_V2_WS_METHODS.subscribeThread>>[2]
>;

const synchronized: OrchestrationV2ThreadStreamItem = { kind: "synchronized" };

const threadCatchUpAdmission = {
  group: "test-thread-detail-catch-up",
  maxConcurrent: 3,
  appliesTo: (input: OrchestrationV2SubscribeThreadInput) => input.requestCompletionMarker === true,
  releaseWhen: (item: OrchestrationV2ThreadStreamItem) => item.kind === "synchronized",
};

function catchUpInput(threadId: ThreadId): OrchestrationV2SubscribeThreadInput {
  return { threadId, requestCompletionMarker: true };
}

function testThreadStream(queue: Queue.Queue<TestThreadStreamItem>) {
  return Stream.fromQueue(queue).pipe(
    Stream.mapEffect((item) => (item instanceof Error ? Effect.fail(item) : Effect.succeed(item))),
  );
}

const makeThreadQueues = (ids: ReadonlyArray<ThreadId>) =>
  Effect.forEach(ids, (id) =>
    Queue.unbounded<TestThreadStreamItem>().pipe(Effect.map((queue) => [id, queue] as const)),
  ).pipe(Effect.map((entries) => new Map(entries)));

function threadQueue(
  queues: ReadonlyMap<ThreadId, Queue.Queue<TestThreadStreamItem>>,
  threadId: ThreadId | undefined,
): Queue.Queue<TestThreadStreamItem> {
  const queue = threadId === undefined ? undefined : queues.get(threadId);
  if (queue === undefined) throw new Error(`Missing test queue for ${threadId ?? "unknown"}.`);
  return queue;
}

/** Records each subscription start, then streams that thread's queue. */
function startRecordingClient(
  starts: Queue.Queue<ThreadId>,
  queues: ReadonlyMap<ThreadId, Queue.Queue<TestThreadStreamItem>>,
): WsRpcProtocolClient {
  return {
    [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input: OrchestrationV2SubscribeThreadInput) =>
      Stream.fromEffect(Queue.offer(starts, input.threadId)).pipe(
        Stream.drain,
        Stream.concat(testThreadStream(threadQueue(queues, input.threadId))),
      ),
  } as unknown as WsRpcProtocolClient;
}

function subscribeThread(
  supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"],
  makeInput: () => Effect.Effect<OrchestrationV2SubscribeThreadInput>,
  options: ThreadSubscriptionOptions = { admission: threadCatchUpAdmission },
) {
  return subscribeDynamic(ORCHESTRATION_V2_WS_METHODS.subscribeThread, makeInput, options).pipe(
    Stream.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  );
}

const offerAll = (
  queues: ReadonlyMap<ThreadId, Queue.Queue<TestThreadStreamItem>>,
  ids: ReadonlyArray<ThreadId>,
) =>
  Effect.forEach(ids, (id) => Queue.offer(threadQueue(queues, id), synchronized), {
    discard: true,
  });

const takeN = <A>(queue: Queue.Queue<A>, count: number) =>
  Effect.all(Array.from({ length: count }, () => Queue.take(queue)));

describe("thread catch-up admission", () => {
  it.effect("admits catch-ups in waves and keeps synchronized subscriptions live", () =>
    Effect.gen(function* () {
      const ids = Array.from({ length: 8 }, (_, index) => ThreadId.make(`thread-${index}`));
      const queues = yield* makeThreadQueues(ids);
      const starts = yield* Queue.unbounded<ThreadId>();
      const active = yield* Ref.make(0);
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (
          input: OrchestrationV2SubscribeThreadInput,
        ) =>
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
        subscribeThread(supervisor, () => Effect.succeed(catchUpInput(threadId))).pipe(
          Stream.runDrain,
          Effect.forkChild,
        ),
      );

      const waves: Array<ReadonlyArray<ThreadId>> = [];
      for (const size of [3, 3, 2]) {
        const wave = yield* takeN(starts, size);
        expect(Option.isNone(yield* Queue.poll(starts))).toBe(true);
        yield* offerAll(queues, wave);
        waves.push(wave);
      }
      expect(new Set(waves.flat())).toEqual(new Set(ids));
      expect(yield* Ref.get(active)).toBe(8);
      yield* Effect.forEach(fibers, Fiber.interrupt, { discard: true });
    }),
  );

  it.effect("does not gate subscriptions that request no completion marker", () =>
    Effect.gen(function* () {
      const ids = Array.from({ length: 4 }, (_, index) => ThreadId.make(`plain-${index}`));
      const queues = yield* makeThreadQueues(ids);
      const starts = yield* Queue.unbounded<ThreadId>();
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(
        activeSession,
        Option.some(session(startRecordingClient(starts, queues))),
      );

      const fibers = yield* Effect.forEach(ids, (threadId) =>
        subscribeThread(supervisor, () => Effect.succeed({ threadId })).pipe(
          Stream.runDrain,
          Effect.forkChild,
        ),
      );

      expect(new Set(yield* takeN(starts, 4))).toEqual(new Set(ids));
      yield* Effect.forEach(fibers, Fiber.interrupt, { discard: true });
    }),
  );

  it.effect("releases catch-up permits after failure and interruption", () =>
    Effect.gen(function* () {
      const ids = Array.from({ length: 5 }, (_, index) => ThreadId.make(`release-${index}`));
      const queues = yield* makeThreadQueues(ids);
      const starts = yield* Queue.unbounded<ThreadId>();
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(
        activeSession,
        Option.some(session(startRecordingClient(starts, queues))),
      );
      const fibers = yield* Effect.forEach(ids, (threadId) =>
        subscribeThread(supervisor, () => Effect.succeed(catchUpInput(threadId))).pipe(
          Stream.runDrain,
          Effect.exit,
          Effect.forkChild,
        ),
      );

      const firstWave = yield* takeN(starts, 3);
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
          [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (
            input: OrchestrationV2SubscribeThreadInput,
          ) =>
            Stream.fromEffect(Queue.offer(starts, input.threadId)).pipe(
              Stream.drain,
              Stream.concat(Stream.never),
            ),
        }) as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(makeClient(firstStarts))));
      const fibers = yield* Effect.forEach(ids, (threadId) =>
        subscribeThread(supervisor, () => Effect.succeed(catchUpInput(threadId))).pipe(
          Stream.runDrain,
          Effect.forkChild,
        ),
      );

      yield* takeN(firstStarts, 3);
      expect(Option.isNone(yield* Queue.poll(firstStarts))).toBe(true);
      yield* SubscriptionRef.set(activeSession, Option.some(session(makeClient(secondStarts))));
      expect(new Set(yield* takeN(secondStarts, 3)).size).toBe(3);
      expect(Option.isNone(yield* Queue.poll(secondStarts))).toBe(true);
      yield* Effect.forEach(fibers, Fiber.interrupt, { discard: true });
    }),
  );

  it.effect("rejects invalid and conflicting admission limits", () =>
    Effect.gen(function* () {
      const starts = yield* Queue.unbounded<ThreadId>();
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (
          input: OrchestrationV2SubscribeThreadInput,
        ) =>
          Stream.fromEffect(Queue.offer(starts, input.threadId)).pipe(
            Stream.drain,
            Stream.concat(Stream.never),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const failureMessage = (maxConcurrent: number, threadId: string) =>
        subscribeThread(supervisor, () => Effect.succeed(catchUpInput(ThreadId.make(threadId))), {
          admission: { ...threadCatchUpAdmission, maxConcurrent },
        }).pipe(
          Stream.runDrain,
          Effect.exit,
          Effect.map((exit) => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "succeeded")),
        );

      for (const maxConcurrent of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
        expect(yield* failureMessage(maxConcurrent, "invalid-limit")).toContain(
          "Subscription admission maxConcurrent must be a positive safe integer",
        );
      }
      expect(Option.isNone(yield* Queue.poll(starts))).toBe(true);

      const firstFiber = yield* subscribeThread(
        supervisor,
        () => Effect.succeed(catchUpInput(ThreadId.make("limit-one"))),
        { admission: { ...threadCatchUpAdmission, maxConcurrent: 1 } },
      ).pipe(Stream.runDrain, Effect.forkChild);
      yield* Queue.take(starts);
      expect(yield* failureMessage(2, "limit-two")).toContain(
        'group "test-thread-detail-catch-up" already uses maxConcurrent 1; received conflicting 2',
      );
      yield* Fiber.interrupt(firstFiber);
    }),
  );

  it.effect("releases admission before an expected-failure retry becomes live", () =>
    Effect.gen(function* () {
      const attemptCount = yield* Ref.make(0);
      const active = yield* Ref.make(0);
      const attempts = yield* Queue.unbounded<{
        readonly attempt: number;
        readonly events: Queue.Queue<TestThreadStreamItem>;
      }>();
      const failures = yield* Queue.unbounded<void>();
      const observed = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: () =>
          Stream.unwrap(
            Effect.gen(function* () {
              const attempt = yield* Ref.updateAndGet(attemptCount, (count) => count + 1);
              const events = yield* Queue.unbounded<TestThreadStreamItem>();
              yield* Ref.update(active, (count) => count + 1);
              yield* Queue.offer(attempts, { attempt, events });
              const stream =
                attempt === 1 ? Stream.fail(new Error("retry catch-up")) : testThreadStream(events);
              return stream.pipe(Stream.ensuring(Ref.update(active, (count) => count - 1)));
            }),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const fiber = yield* subscribeThread(
        supervisor,
        () => Effect.succeed(catchUpInput(ThreadId.make("retry-live"))),
        {
          admission: { ...threadCatchUpAdmission, maxConcurrent: 1 },
          onExpectedFailure: () => Queue.offer(failures, undefined),
          retryExpectedFailureAfter: "100 millis",
        },
      ).pipe(
        Stream.runForEach((item) => Queue.offer(observed, item)),
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

  it.effect("cancels a queued waiter without granting a ghost permit", () =>
    Effect.gen(function* () {
      const ids = Array.from({ length: 5 }, (_, index) => ThreadId.make(`cancel-${index}`));
      const queues = yield* makeThreadQueues(ids);
      const starts = yield* Queue.unbounded<ThreadId>();
      const attempts = yield* Queue.unbounded<ThreadId>();
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(
        activeSession,
        Option.some(session(startRecordingClient(starts, queues))),
      );
      const fibers = yield* Effect.forEach(ids, (threadId) =>
        subscribeThread(supervisor, () =>
          Queue.offer(attempts, threadId).pipe(Effect.as(catchUpInput(threadId))),
        ).pipe(Stream.runDrain, Effect.forkChild),
      );
      const firstWave = yield* takeN(starts, 3);
      expect(firstWave).toEqual(ids.slice(0, 3));
      expect(yield* takeN(attempts, 5)).toEqual(ids);
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
      const queues = yield* makeThreadQueues(ids);
      const starts = yield* Queue.unbounded<ThreadId>();
      const consumed = yield* Queue.unbounded<{
        readonly threadId: ThreadId;
        readonly item: OrchestrationV2ThreadStreamItem;
      }>();
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(
        activeSession,
        Option.some(session(startRecordingClient(starts, queues))),
      );
      const fibers = yield* Effect.forEach(ids, (threadId) =>
        subscribeThread(supervisor, () => Effect.succeed(catchUpInput(threadId)), {
          admission: { ...threadCatchUpAdmission, maxConcurrent: 1 },
        }).pipe(
          Stream.runForEach((item) => Queue.offer(consumed, { threadId, item })),
          Effect.forkChild,
        ),
      );

      expect(yield* Queue.take(starts)).toBe(ids[0]);
      yield* Queue.offer(threadQueue(queues, ids[0]), synchronized);
      yield* Queue.offer(threadQueue(queues, ids[0]), synchronized);
      expect(yield* Queue.take(starts)).toBe(ids[1]);
      expect(yield* takeN(consumed, 2)).toEqual([
        { threadId: ids[0], item: synchronized },
        { threadId: ids[0], item: synchronized },
      ]);
      expect(Option.isNone(yield* Queue.poll(starts))).toBe(true);
      yield* Queue.offer(threadQueue(queues, ids[1]), synchronized);
      expect(yield* Queue.take(starts)).toBe(ids[2]);
      yield* Effect.forEach(fibers, Fiber.interrupt, { discard: true });
    }),
  );
});
