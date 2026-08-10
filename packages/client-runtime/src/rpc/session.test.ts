import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ServerConfig,
  type ServerConfig as ServerConfigType,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import * as Socket from "effect/unstable/socket/Socket";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import * as Connectivity from "../connection/connectivity.ts";
import * as ConnectionDriver from "../connection/driver.ts";
import {
  ConnectionTransientError,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as ConnectionResolver from "../connection/resolver.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import * as RpcSession from "./session.ts";

type SocketEventType = "open" | "message" | "close" | "error";
type SocketEvent = {
  readonly code?: number;
  readonly data?: unknown;
  readonly reason?: string;
  readonly type: SocketEventType;
};
type SocketListener = (event: SocketEvent) => void;

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = TestWebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly url: string;
  private readonly listeners = new Map<SocketEventType, Set<SocketListener>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: SocketEventType, listener: SocketListener) {
    const listeners = this.listeners.get(type) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: SocketEventType, listener: SocketListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === TestWebSocket.CLOSED) {
      return;
    }
    this.readyState = TestWebSocket.CLOSED;
    this.emit("close", { code, reason, type: "close" });
  }

  open() {
    this.readyState = TestWebSocket.OPEN;
    this.emit("open", { type: "open" });
  }

  serverMessage(data: string) {
    this.emit("message", { data, type: "message" });
  }

  private emit(type: SocketEventType, event: SocketEvent) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws?wsTicket=test",
  httpAuthorization: null,
  target: TARGET,
};

const TARGET_ENTRY: ConnectionCatalogEntry = {
  target: TARGET,
  profile: Option.none(),
};

const SERVER_CONFIG: ServerConfigType = {
  environment: {
    environmentId: TARGET.environmentId,
    label: TARGET.label,
    platform: {
      os: "darwin",
      arch: "arm64",
    },
    serverVersion: "0.0.0-test",
    capabilities: {
      repositoryIdentity: true,
      connectionProbe: true,
    },
  },
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie", "bearer-access-token"],
    sessionCookieName: "t3_session",
  },
  cwd: "/tmp/workspace",
  keybindingsConfigPath: "/tmp/workspace/keybindings.json",
  keybindings: [],
  issues: [],
  providers: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/tmp/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
};

const RpcRequest = Schema.TaggedStruct("Request", {
  id: Schema.Union([Schema.String, Schema.Number]),
  payload: Schema.Unknown,
  tag: Schema.String,
});
const TaggedRpcFrame = Schema.Struct({ _tag: Schema.String });
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeRpcRequest = Schema.decodeUnknownSync(RpcRequest);
const isTaggedRpcFrame = Schema.is(TaggedRpcFrame);
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeServerConfig = Schema.encodeSync(ServerConfig);
const ENCODED_SERVER_CONFIG = encodeServerConfig(SERVER_CONFIG);
const LEGACY_SERVER_CONFIG = {
  ...ENCODED_SERVER_CONFIG,
  environment: {
    ...ENCODED_SERVER_CONFIG.environment,
    capabilities: {
      repositoryIdentity: true,
    },
  },
};

const DEPENDENCY_PING_CADENCE_MS = 5_000;
const DEPENDENCY_LIVENESS_CLOSURE_MS = DEPENDENCY_PING_CADENCE_MS * 3;
const LIVENESS_OBSERVATION_STEP_MS = 1_000;
const POST_CLOSURE_OBSERVATION_MS = DEPENDENCY_PING_CADENCE_MS + 1_000;

const makeFactory = Effect.fn("TestRpcSessionFactory.make")(function* () {
  const sockets: TestWebSocket[] = [];
  const constructorLayer = Layer.succeed(Socket.WebSocketConstructor, (url) => {
    const socket = new TestWebSocket(url);
    sockets.push(socket);
    return socket as unknown as globalThis.WebSocket;
  });
  const layer = RpcSession.layer.pipe(Layer.provide(constructorLayer));
  const factory = yield* RpcSession.RpcSessionFactory.pipe(Effect.provide(layer));
  return { factory, sockets };
});

const awaitSocket = Effect.fn("TestRpcSessionFactory.awaitSocket")(function* (
  sockets: ReadonlyArray<TestWebSocket>,
  index = 0,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const socket = sockets[index];
    if (socket) {
      return socket;
    }
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(new Error("Expected the RPC protocol to create a websocket."));
});

function framesWithTag(socket: TestWebSocket, tag: string) {
  return socket.sent
    .map((frame) => decodeJson(frame))
    .filter(isTaggedRpcFrame)
    .filter((frame) => frame._tag === tag);
}

const awaitNextPing = Effect.fn("TestRpcSessionFactory.awaitNextPing")(function* (
  socket: TestWebSocket,
  observedPingCount: number,
) {
  for (
    let elapsedMs = 0;
    elapsedMs <= DEPENDENCY_PING_CADENCE_MS;
    elapsedMs += LIVENESS_OBSERVATION_STEP_MS
  ) {
    const pings = framesWithTag(socket, "Ping");
    if (pings.length > observedPingCount) {
      return pings.length;
    }
    if (elapsedMs < DEPENDENCY_PING_CADENCE_MS) {
      yield* TestClock.adjust(LIVENESS_OBSERVATION_STEP_MS);
    }
  }
  return yield* Effect.die(
    new Error("Expected Effect RPC to emit a Ping within its five-second cadence."),
  );
});

const awaitLivenessClosure = Effect.fn("TestRpcSessionFactory.awaitLivenessClosure")(function* (
  socket: TestWebSocket,
) {
  for (
    let elapsedMs = 0;
    elapsedMs <= DEPENDENCY_LIVENESS_CLOSURE_MS;
    elapsedMs += LIVENESS_OBSERVATION_STEP_MS
  ) {
    if (socket.readyState === TestWebSocket.CLOSED) {
      return;
    }
    if (elapsedMs < DEPENDENCY_LIVENESS_CLOSURE_MS) {
      yield* TestClock.adjust(LIVENESS_OBSERVATION_STEP_MS);
    }
  }
  return yield* Effect.die(
    new Error("Expected unanswered Pings to close the session after the missed-pong tolerance."),
  );
});

const eventuallySupervisorState = Effect.fn("TestRpcSessionFactory.eventuallySupervisorState")(
  function* (
    state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>,
    predicate: (state: SupervisorConnectionState) => boolean,
  ) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = yield* SubscriptionRef.get(state);
      if (predicate(current)) {
        return current;
      }
      yield* Effect.yieldNow;
    }
    const current = yield* SubscriptionRef.get(state);
    if (predicate(current)) {
      return current;
    }
    return yield* Effect.die(
      new Error(
        `Expected EnvironmentSupervisor state was not observed. Last phase: ${current.phase}`,
      ),
    );
  },
);

const awaitRequest = Effect.fn("TestRpcSessionFactory.awaitRequest")(function* (
  socket: TestWebSocket,
  index = 0,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const request = socket.sent[index];
    if (request) {
      return decodeRpcRequest(decodeJson(request));
    }
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(new Error("Expected the RPC protocol to send a request."));
});

const completeInitialConfig = Effect.fn("TestRpcSessionFactory.completeInitialConfig")(function* (
  socket: TestWebSocket,
  config: unknown = ENCODED_SERVER_CONFIG,
) {
  const request = yield* awaitRequest(socket);
  expect(request).toMatchObject({
    _tag: "Request",
    tag: WS_METHODS.serverGetConfig,
    payload: {},
  });
  socket.serverMessage(
    encodeJson({
      _tag: "Exit",
      requestId: request.id,
      exit: {
        _tag: "Success",
        value: config,
      },
    }),
  );
});

describe("RpcSessionFactory", () => {
  it.effect("owns one scoped websocket attempt and exposes readiness and closure", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const readyFiber = yield* Effect.forkChild(session.ready);
      const socket = yield* awaitSocket(sockets);

      expect(socket.url).toBe(PREPARED.socketUrl);
      socket.open();
      yield* completeInitialConfig(socket);
      yield* Fiber.join(readyFiber);

      const config = yield* session.initialConfig;
      expect(config).toEqual(SERVER_CONFIG);

      const probeFiber = yield* Effect.forkChild(session.probe);
      const probeRequest = yield* awaitRequest(socket, 1);
      expect(probeRequest).toMatchObject({
        _tag: "Request",
        tag: WS_METHODS.serverProbe,
        payload: {},
      });
      socket.serverMessage(
        encodeJson({
          _tag: "Exit",
          requestId: probeRequest.id,
          exit: {
            _tag: "Success",
            value: {},
          },
        }),
      );
      yield* Fiber.join(probeFiber);

      expect(socket.sent.map((request) => decodeRpcRequest(decodeJson(request)).tag)).toEqual([
        WS_METHODS.serverGetConfig,
        WS_METHODS.serverProbe,
      ]);

      socket.close(1012, "service restart");
      const error = yield* Effect.flip(session.closed);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error).toMatchObject({
        reason: "transport",
        message:
          'Test environment disconnected. WebSocket close code 1012, reason "service restart".',
      });
      yield* Effect.yieldNow;
      expect(sockets).toHaveLength(1);
    }),
  );

  it.effect("uses Effect ping/pong liveness without replacing the scoped websocket", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const readyFiber = yield* Effect.forkChild(session.ready);
      const socket = yield* awaitSocket(sockets);

      socket.open();
      yield* completeInitialConfig(socket);
      yield* Fiber.join(readyFiber);

      const observedPingCount = yield* awaitNextPing(socket, 0);

      socket.serverMessage(encodeJson({ _tag: "Pong" }));
      yield* Effect.yieldNow;
      yield* awaitNextPing(socket, observedPingCount);

      const closedFiber = yield* Effect.forkChild(Effect.flip(session.closed));
      yield* awaitLivenessClosure(socket);
      const error = yield* Fiber.join(closedFiber);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error).toMatchObject({
        reason: "transport",
        message: "Test environment disconnected.",
      });
      expect(socket.readyState).toBe(TestWebSocket.CLOSED);

      // Keep the scoped session alive past another complete dependency cadence.
      // Its configured zero-retry policy must never construct a delayed replacement.
      yield* TestClock.adjust(POST_CLOSURE_OBSERVATION_MS);
      yield* Effect.yieldNow;
      expect(sockets).toHaveLength(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("hands an unanswered ping closure to the supervisor for one replacement", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const resolver = ConnectionResolver.ConnectionResolver.of({
        prepare: () => Effect.succeed(PREPARED),
      });
      const driver = yield* ConnectionDriver.make.pipe(
        Effect.provideService(ConnectionResolver.ConnectionResolver, resolver),
        Effect.provideService(RpcSession.RpcSessionFactory, factory),
      );
      const connectivity = Connectivity.Connectivity.of({
        status: Effect.succeed("online"),
        changes: Stream.never,
      });
      const wakeups = ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.never });

      const serveSocket = Effect.fn("TestRpcSessionFactory.serveSocket")(function* (index: number) {
        const socket = yield* awaitSocket(sockets, index);
        socket.open();
        yield* completeInitialConfig(socket);
        return socket;
      });

      const firstSocketFiber = yield* Effect.forkChild(serveSocket(0));
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(
        Effect.provideService(ConnectionDriver.ConnectionDriver, driver),
        Effect.provideService(Connectivity.Connectivity, connectivity),
        Effect.provideService(ConnectionWakeups.ConnectionWakeups, wakeups),
      );
      yield* eventuallySupervisorState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      const firstSocket = yield* Fiber.join(firstSocketFiber);

      yield* awaitNextPing(firstSocket, 0);
      yield* awaitLivenessClosure(firstSocket);
      yield* eventuallySupervisorState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      expect(sockets).toHaveLength(1);

      const replacementSocketFiber = yield* Effect.forkChild(serveSocket(1));
      yield* TestClock.adjust("3 seconds");
      yield* eventuallySupervisorState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      yield* Fiber.join(replacementSocketFiber);

      expect(sockets).toHaveLength(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("includes websocket close diagnostics when the connection drops before ready", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const readyFiber = yield* Effect.forkChild(Effect.flip(session.ready));
      const socket = yield* awaitSocket(sockets);

      socket.close(1006, "");
      const error = yield* Fiber.join(readyFiber);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error).toMatchObject({
        reason: "transport",
        message:
          "Test environment could not establish a WebSocket connection. WebSocket close code 1006.",
      });
    }),
  );

  it.effect("closes the websocket when the session scope is released", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* factory.connect(PREPARED);
          const readyFiber = yield* Effect.forkChild(session.ready);
          const socket = yield* awaitSocket(sockets);
          socket.open();
          yield* completeInitialConfig(socket);
          yield* Fiber.join(readyFiber);
        }),
      );

      expect(sockets[0]?.readyState).toBe(TestWebSocket.CLOSED);
    }),
  );

  it.effect("tolerates two missed pong windows before closing the session", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const readyFiber = yield* Effect.forkChild(session.ready);
      const closedFiber = yield* Effect.forkChild(Effect.flip(session.closed));
      const socket = yield* awaitSocket(sockets);

      socket.open();
      yield* completeInitialConfig(socket);
      yield* Fiber.join(readyFiber);

      yield* TestClock.adjust("15 seconds");
      expect(closedFiber.pollUnsafe()).toBeUndefined();
      expect(socket.sent.slice(1).map((request) => decodeJson(request))).toEqual([
        { _tag: "Ping" },
        { _tag: "Ping" },
        { _tag: "Ping" },
      ]);

      yield* TestClock.adjust("5 seconds");
      const error = yield* Fiber.join(closedFiber);
      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error).toMatchObject({ reason: "transport" });
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("reaches ready when a newer server sends unknown config members", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const readyFiber = yield* Effect.forkChild(session.ready);
      const socket = yield* awaitSocket(sockets);
      socket.open();

      const shortcut = {
        key: "p",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      };
      yield* completeInitialConfig(socket, {
        ...ENCODED_SERVER_CONFIG,
        keybindings: [
          { command: "someFuture.toggle", shortcut },
          { command: "terminal.toggle", shortcut },
        ],
        issues: [{ kind: "keybindings.future-issue", message: "From a newer server" }],
        availableEditors: ["some-future-editor", "zed"],
      });
      yield* Fiber.join(readyFiber);

      const config = yield* session.initialConfig;
      expect(config.keybindings).toEqual([{ command: "terminal.toggle", shortcut }]);
      expect(config.issues).toEqual([]);
      expect(config.availableEditors).toEqual(["zed"]);
    }),
  );

  it.effect("uses the legacy config RPC for probes when the server lacks the capability", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { factory, sockets } = yield* makeFactory();
        const session = yield* factory.connect(PREPARED);
        const readyFiber = yield* Effect.forkChild(session.ready);
        const socket = yield* awaitSocket(sockets);

        socket.open();
        yield* completeInitialConfig(socket, LEGACY_SERVER_CONFIG);
        yield* Fiber.join(readyFiber);

        const probeFiber = yield* Effect.forkChild(session.probe);
        const probeRequest = yield* awaitRequest(socket, 1);
        expect(probeRequest).toMatchObject({
          _tag: "Request",
          tag: WS_METHODS.serverGetConfig,
          payload: {},
        });
        socket.serverMessage(
          encodeJson({
            _tag: "Exit",
            requestId: probeRequest.id,
            exit: {
              _tag: "Success",
              value: LEGACY_SERVER_CONFIG,
            },
          }),
        );
        yield* Fiber.join(probeFiber);

        expect(socket.sent.map((request) => decodeRpcRequest(decodeJson(request)).tag)).toEqual([
          WS_METHODS.serverGetConfig,
          WS_METHODS.serverGetConfig,
        ]);
      }),
    ),
  );

  it.effect("fails readiness when the websocket never opens", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();

      const error = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* factory.connect(PREPARED);
          const readyFiber = yield* Effect.forkChild(Effect.flip(session.ready));
          yield* awaitSocket(sockets);

          yield* TestClock.adjust("15 seconds");
          return yield* Fiber.join(readyFiber);
        }),
      );

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error).toMatchObject({
        reason: "transport",
        message: "Test environment could not establish a WebSocket connection.",
      });
      expect(sockets[0]?.readyState).toBe(TestWebSocket.CLOSED);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
