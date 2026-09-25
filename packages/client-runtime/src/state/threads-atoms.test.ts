import {
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type NetworkStatus,
  type PreparedConnection,
} from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { ConnectionWakeups, type ConnectionWakeup } from "../connection/wakeups.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createEnvironmentThreadDetailAtoms } from "./threadDetail.ts";
import { THREAD_STATE_IDLE_TTL_MS } from "./threadRetention.ts";
import {
  createEnvironmentThreadStateAtoms,
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
const THREAD: OrchestrationThread = {
  id: THREAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Cached thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "ModelA" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  pullRequests: [],
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
const SNAPSHOT: OrchestrationThreadDetailSnapshot = {
  snapshotSequence: 7,
  activityDetailMode: "full",
  thread: THREAD,
};

// Drives the real thread-state atoms through a registry, counting HTTP and
// disk loads plus opened and still-active thread subscriptions.
const makeHarness = Effect.fn("TestThreadAtoms.makeHarness")(function* () {
  const clock = yield* Clock.Clock;
  const wakeups = yield* Queue.unbounded<ConnectionWakeup>();
  const subscriptions = yield* Queue.unbounded<{
    readonly events: Queue.Queue<OrchestrationThreadStreamItem, Error>;
    readonly closed: Deferred.Deferred<void>;
  }>();
  let httpLoads = 0;
  let diskLoads = 0;
  let opened = 0;
  let active = 0;
  const client = {
    [ORCHESTRATION_WS_METHODS.subscribeThread]: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<OrchestrationThreadStreamItem, Error>();
          const closed = yield* Deferred.make<void>();
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              opened += 1;
              active += 1;
            }),
            () =>
              Effect.sync(() => {
                active -= 1;
              }).pipe(Effect.andThen(Deferred.succeed(closed, undefined))),
          );
          yield* Queue.offer(subscriptions, { events, closed });
          return Stream.fromQueue(events);
        }),
      ),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.succeed({ threadResumeCompletionMarker: true } as never),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
      Option.some({
        environmentId: TARGET.environmentId,
        label: TARGET.label,
        httpBaseUrl: TARGET.httpBaseUrl,
        socketUrl: TARGET.wsBaseUrl,
        httpAuthorization: null,
        target: TARGET,
      }),
    ),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const environmentRegistry = EnvironmentRegistry.of({
    entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map(),
    ),
    networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
    start: Effect.void,
    register: () => Effect.die("Unexpected environment registration"),
    registerPlatform: () => Effect.die("Unexpected environment registration"),
    reconcilePlatform: () => Effect.die("Unexpected environment reconciliation"),
    remove: () => Effect.die("Unexpected environment removal"),
    removeRelayEnvironments: () => Effect.die("Unexpected environment removal"),
    retryNow: () => Effect.void,
    setEnabled: () => Effect.die("Unexpected environment toggle"),
    setCompatibility: () => Effect.die("Unexpected compatibility update"),
    state: () => SubscriptionRef.get(supervisor.state),
    stateChanges: () => SubscriptionRef.changes(supervisor.state),
    run: (_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor, supervisor),
    runStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor, supervisor),
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  });
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(Clock.Clock, clock),
      Layer.succeed(ConnectionWakeups, { changes: Stream.fromQueue(wakeups) }),
      Layer.succeed(EnvironmentRegistry, environmentRegistry),
      Layer.succeed(
        EnvironmentCacheStore,
        EnvironmentCacheStore.of({
          loadShell: () => Effect.succeed(Option.none()),
          saveShell: () => Effect.void,
          loadThread: () =>
            Effect.sync(() => {
              diskLoads += 1;
              return Option.none();
            }),
          saveThread: () => Effect.void,
          removeThread: () => Effect.void,
          loadServerConfig: () => Effect.succeed(Option.none()),
          saveServerConfig: () => Effect.void,
          loadVcsRefs: () => Effect.succeed(Option.none()),
          saveVcsRefs: () => Effect.void,
          removeVcsRefs: () => Effect.void,
          clearVcsRefs: () => Effect.void,
          clear: () => Effect.void,
        }),
      ),
      Layer.succeed(
        ThreadSnapshotLoader,
        ThreadSnapshotLoader.of({
          load: () =>
            Effect.sync(() => {
              httpLoads += 1;
              return { _tag: "Found" as const, snapshot: SNAPSHOT };
            }),
          loadTurnActivities: () => Effect.die("Unexpected turn activity load"),
        }),
      ),
    ),
  );
  const raw = createEnvironmentThreadStateAtoms(runtime);
  const details = createEnvironmentThreadDetailAtoms(raw.stateAtom);
  const ref = { environmentId: TARGET.environmentId, threadId: THREAD_ID };
  const registry = yield* Effect.acquireRelease(
    Effect.sync(() => AtomRegistry.make({ defaultIdleTTL: 60_000, timeoutResolution: 1 })),
    (registry) => Effect.sync(() => registry.dispose()),
  );

  return {
    registry,
    raw,
    details,
    ref,
    subscriptions,
    counts: () => ({ httpLoads, diskLoads, opened, active }),
  };
});

function observeState(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<EnvironmentThreadState>,
  predicate: (state: EnvironmentThreadState) => boolean,
) {
  return AtomRegistry.toStream(registry, atom).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
}

describe("createEnvironmentThreadStateAtoms", () => {
  it.effect("releases thread state immediately after its last subscriber leaves", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const atom = h.raw.stateAtom(h.ref.environmentId, h.ref.threadId);

      expect(atom.idleTTL).toBe(THREAD_STATE_IDLE_TTL_MS);
      expect(atom.idleTTL).toBe(0);
      expect(h.raw.stateAtom(h.ref.environmentId, h.ref.threadId)).toBe(atom);
      expect(h.raw.stateAtom(h.ref.environmentId, ThreadId.make("thread-2"))).not.toBe(atom);
    }),
  );

  it.effect("shares one live stream and closes it after the last detail consumer leaves", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const unmountMessages = h.registry.mount(h.details.messagesAtom(h.ref));
      const first = yield* Queue.take(h.subscriptions);
      const unmountStatus = h.registry.mount(h.details.statusAtom(h.ref));
      expect(h.counts()).toEqual({ httpLoads: 1, diskLoads: 1, opened: 1, active: 1 });

      unmountMessages();
      yield* Queue.offer(first.events, { kind: "synchronized" });
      yield* observeState(h.registry, h.details.stateAtom(h.ref), (state) => {
        return state.status === "live";
      });
      expect(h.counts().active).toBe(1);

      unmountStatus();
      yield* Deferred.await(first.closed);
      expect(h.counts().active).toBe(0);
    }),
  );
});
