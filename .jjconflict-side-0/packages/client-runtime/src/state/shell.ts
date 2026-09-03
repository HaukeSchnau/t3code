import {
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamItem,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { subscribeWithSessionDynamic } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import { ShellSnapshotLoader } from "./shellSnapshotHttp.ts";
import { applyShellStreamEvent } from "./shellReducer.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import { followStreamInEnvironment } from "./runtime.ts";

export type EnvironmentShellStatus = "empty" | "cached" | "synchronizing" | "live";

export interface EnvironmentShellState {
  readonly snapshot: Option.Option<OrchestrationShellSnapshot>;
  readonly status: EnvironmentShellStatus;
  readonly error: Option.Option<string>;
}

const EMPTY_SHELL_STATE: EnvironmentShellState = {
  snapshot: Option.none(),
  status: "empty",
  error: Option.none(),
};

function shellStatusForSnapshot(
  snapshot: Option.Option<OrchestrationShellSnapshot>,
): EnvironmentShellStatus {
  return Option.isSome(snapshot) ? "cached" : "empty";
}

const SHELL_SYNCHRONIZATION_ERROR_MESSAGE = "Could not synchronize environment data.";

export const makeEnvironmentShellState = Effect.fn("EnvironmentShellState.make")(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const snapshotLoader = yield* ShellSnapshotLoader;
  const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
  const environmentId = supervisor.target.environmentId;
  const cachedSnapshot = yield* cache.loadShell(environmentId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not load cached environment shell.").pipe(
        Effect.annotateLogs({
          environmentId,
          ...safeErrorLogAttributes(error),
        }),
        Effect.as(Option.none<OrchestrationShellSnapshot>()),
      ),
    ),
  );
  const state = yield* SubscriptionRef.make<EnvironmentShellState>({
    snapshot: cachedSnapshot,
    status: shellStatusForSnapshot(cachedSnapshot),
    error: Option.none(),
  });
  const lastSequence = yield* SubscriptionRef.make(
    Option.match(cachedSnapshot, {
      onNone: () => 0,
      onSome: (snapshot) => snapshot.snapshotSequence,
    }),
  );
  const awaitingCompletion = yield* Ref.make(false);
  const persistence = yield* Queue.sliding<OrchestrationShellSnapshot>(1);
  const subscriptionSynchronization = yield* Ref.make({
    generation: -1,
    session: null as RpcSession | null,
    synchronized: false,
  });
  const latestConnectionGeneration = yield* Ref.make(-1);

  const persist = Effect.fn("EnvironmentShellState.persist")(function* (
    snapshot: OrchestrationShellSnapshot,
  ) {
    yield* cache.saveShell(environmentId, snapshot).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not persist environment shell cache.").pipe(
          Effect.annotateLogs({
            environmentId,
            ...safeErrorLogAttributes(error),
          }),
        ),
      ),
    );
  });

  yield* Stream.fromQueue(persistence).pipe(
    Stream.debounce("500 millis"),
    Stream.runForEach(persist),
    Effect.forkScoped,
  );

  const markGenerationUnsynchronized = (generation: number) =>
    Ref.update(subscriptionSynchronization, (current) =>
      current.generation < generation
        ? { generation, session: null, synchronized: false }
        : current,
    );
  const setDisconnected = (generation: number) =>
    Ref.update(subscriptionSynchronization, (current) =>
      current.generation <= generation
        ? { generation, session: null, synchronized: false }
        : current,
    ).pipe(
      Effect.andThen(Ref.set(awaitingCompletion, false)),
      Effect.andThen(
        SubscriptionRef.update(state, (current) => ({
          ...current,
          status: shellStatusForSnapshot(current.snapshot),
        })),
      ),
    );
  const setSynchronizing = SubscriptionRef.update(state, (current) => ({
    ...current,
    status: "synchronizing" as const,
    error: Option.none(),
  }));
  const setReady = (generation: number) =>
    Effect.all([
      Ref.get(subscriptionSynchronization),
      SubscriptionRef.get(supervisor.session),
    ]).pipe(
      Effect.flatMap(([synchronization, currentSession]) =>
        SubscriptionRef.update(state, (current) =>
          current.status === "live" ||
          (synchronization.generation === generation &&
            synchronization.synchronized &&
            Option.isSome(currentSession) &&
            synchronization.session === currentSession.value &&
            Option.isSome(current.snapshot))
            ? { ...current, status: "live" as const, error: Option.none() }
            : {
                ...current,
                status: "synchronizing" as const,
                error: Option.none(),
              },
        ),
      ),
    );
  const setStreamError = (error: unknown) =>
    Ref.set(awaitingCompletion, false).pipe(
      Effect.andThen(Effect.logWarning("Could not synchronize the environment shell.")),
      Effect.annotateLogs({
        environmentId,
        ...safeErrorLogAttributes(error),
      }),
      Effect.andThen(
        SubscriptionRef.update(state, (current) => ({
          ...current,
          status: shellStatusForSnapshot(current.snapshot),
          error: Option.some(SHELL_SYNCHRONIZATION_ERROR_MESSAGE),
        })),
      ),
    );

  const applyItem = Effect.fn("EnvironmentShellState.applyItem")(function* (
    item: OrchestrationShellStreamItem,
    itemSession?: RpcSession,
    itemGeneration?: number,
  ) {
    if (item.kind === "synchronized") {
      const [currentSession, connectionState] = yield* Effect.all([
        SubscriptionRef.get(supervisor.session),
        SubscriptionRef.get(supervisor.state),
      ]);
      if (
        itemSession === undefined ||
        itemGeneration === undefined ||
        Option.isNone(currentSession) ||
        currentSession.value !== itemSession ||
        connectionState.generation !== itemGeneration
      ) {
        return;
      }
      const accepted = yield* Ref.modify(subscriptionSynchronization, (current) =>
        current.generation > itemGeneration
          ? [false, current]
          : [true, { generation: itemGeneration, session: itemSession, synchronized: true }],
      );
      if (!accepted) return;
      yield* Ref.set(awaitingCompletion, false);
      yield* SubscriptionRef.update(state, (current) =>
        Option.isSome(current.snapshot)
          ? { ...current, status: "live" as const, error: Option.none() }
          : current,
      );
      return;
    }

    if (item.kind === "snapshot") {
      const waiting = yield* Ref.get(awaitingCompletion);
      yield* SubscriptionRef.set(lastSequence, item.snapshot.snapshotSequence);
      yield* SubscriptionRef.set(state, {
        snapshot: Option.some(item.snapshot),
        status: waiting ? "synchronizing" : "live",
        error: Option.none(),
      });
      yield* Queue.offer(persistence, item.snapshot);
      return;
    }

    const sequence = yield* SubscriptionRef.get(lastSequence);
    if (item.sequence <= sequence) return;
    yield* SubscriptionRef.set(lastSequence, item.sequence);
    if (item.kind === "cursor") {
      const current = yield* SubscriptionRef.get(state);
      yield* Option.match(current.snapshot, {
        onNone: () => Effect.void,
        onSome: (snapshot) =>
          Queue.offer(persistence, { ...snapshot, snapshotSequence: item.sequence }),
      });
      return;
    }

    const current = yield* SubscriptionRef.get(state);
    const nextSnapshot = Option.match(current.snapshot, {
      onNone: () => null,
      onSome: (snapshot) => applyShellStreamEvent(snapshot, item),
    });
    if (nextSnapshot === null) {
      return;
    }

    const waiting = yield* Ref.get(awaitingCompletion);
    yield* SubscriptionRef.set(state, {
      snapshot: Option.some(nextSnapshot),
      status: waiting ? "synchronizing" : "live",
      error: Option.none(),
    });
    yield* Queue.offer(persistence, nextSnapshot);
  });

  const foregroundResubscriptions = Option.match(wakeups, {
    onNone: () => Stream.never,
    onSome: (service) =>
      service.changes.pipe(Stream.filter(ConnectionWakeups.shouldResubscribeAfterWakeup)),
  });

  yield* setSynchronizing;
  yield* Effect.forkScoped(
    subscribeWithSessionDynamic(
      ORCHESTRATION_WS_METHODS.subscribeShell,
      Effect.fn("EnvironmentShellState.makeSubscribeInput")(function* (session) {
        const supportsCompletionMarker = yield* session.initialConfig.pipe(
          Effect.map((config) => config.shellResumeCompletionMarker === true),
          Effect.orElseSucceed(() => false),
        );
        yield* Ref.set(awaitingCompletion, supportsCompletionMarker);
        yield* setSynchronizing;

        // Refresh on every admitted subscription, including foreground
        // wakeups. The HTTP snapshot is cheap and prevents an otherwise valid
        // cursor from preserving incomplete cached shell content.
        const prepared = yield* SubscriptionRef.get(supervisor.prepared).pipe(
          Effect.flatMap(
            Option.match({
              onSome: Effect.succeed,
              onNone: () =>
                SubscriptionRef.changes(supervisor.prepared).pipe(
                  Stream.filter(Option.isSome),
                  Stream.map((value) => value.value),
                  Stream.runHead,
                  Effect.map(Option.getOrThrow),
                ),
            }),
          ),
        );
        const httpSnapshot = yield* snapshotLoader.load(prepared);
        if (Option.isNone(httpSnapshot)) {
          return {
            includeCursorItems: true as const,
            ...(supportsCompletionMarker ? { requestCompletionMarker: true as const } : {}),
          };
        }
        yield* applyItem({ kind: "snapshot", snapshot: httpSnapshot.value });
        if (!supportsCompletionMarker) {
          // Without a completion marker there is no synchronized signal for a
          // resumed subscription, so report live immediately, like threads.
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            status: "live" as const,
            error: Option.none(),
          }));
        }
        return {
          afterSequence: httpSnapshot.value.snapshotSequence,
          includeCursorItems: true as const,
          ...(supportsCompletionMarker ? { requestCompletionMarker: true as const } : {}),
        };
      }),
      {
        onExpectedFailure: (cause) => setStreamError(Cause.squash(cause)),
        retryExpectedFailureAfter: "250 millis",
        resubscribe: foregroundResubscriptions,
      },
    ).pipe(Stream.runForEach((item) => applyItem(item.value, item.session, item.generation))),
  );
  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach((connectionState) => {
      const acceptGeneration = Ref.modify(latestConnectionGeneration, (latest) =>
        connectionState.generation < latest ? [false, latest] : [true, connectionState.generation],
      );
      return acceptGeneration.pipe(
        Effect.flatMap((accepted) => {
          if (!accepted) return Effect.void;
          switch (connectionProjectionPhase(connectionState)) {
            case "synchronizing":
              return markGenerationUnsynchronized(connectionState.generation).pipe(
                Effect.andThen(setSynchronizing),
              );
            case "disconnected":
              return setDisconnected(connectionState.generation);
            case "ready":
              return setReady(connectionState.generation);
          }
        }),
      );
    }),
    Effect.forkScoped,
  );

  return state;
});

export function shellStateChanges(environmentId: EnvironmentId) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(makeEnvironmentShellState().pipe(Effect.map(SubscriptionRef.changes))),
  );
}

export interface EnvironmentShellSummary {
  readonly hasSnapshot: boolean;
  readonly hasSynchronizingShell: boolean;
  readonly hasCachedShell: boolean;
  readonly hasLiveShell: boolean;
  readonly firstError: string | null;
  readonly latestSnapshotUpdatedAt: string | null;
}

const EMPTY_ENVIRONMENT_SHELL_SUMMARY: EnvironmentShellSummary = Object.freeze({
  hasSnapshot: false,
  hasSynchronizingShell: false,
  hasCachedShell: false,
  hasLiveShell: false,
  firstError: null,
  latestSnapshotUpdatedAt: null,
});

const EMPTY_SERVER_CONFIGS: ReadonlyMap<EnvironmentId, ServerConfig> = new Map();

function shellSummariesEqual(
  left: EnvironmentShellSummary,
  right: EnvironmentShellSummary,
): boolean {
  return (
    left.hasSnapshot === right.hasSnapshot &&
    left.hasSynchronizingShell === right.hasSynchronizingShell &&
    left.hasCachedShell === right.hasCachedShell &&
    left.hasLiveShell === right.hasLiveShell &&
    left.firstError === right.firstError &&
    left.latestSnapshotUpdatedAt === right.latestSnapshotUpdatedAt
  );
}

function mapsEqual<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false;
    }
  }
  return true;
}

export function createEnvironmentShellSummaryAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly shellStateValueAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>;
}) {
  let previousSummary = EMPTY_ENVIRONMENT_SHELL_SUMMARY;
  return Atom.make((get) => {
    let hasSnapshot = false;
    let hasSynchronizingShell = false;
    let hasCachedShell = false;
    let hasLiveShell = false;
    let firstError: string | null = null;
    let latestSnapshotUpdatedAt: string | null = null;

    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      const state = get(input.shellStateValueAtom(environmentId));
      hasSynchronizingShell ||= state.status === "synchronizing";
      hasCachedShell ||= state.status === "cached";
      hasLiveShell ||= state.status === "live";
      if (firstError === null) {
        firstError = Option.getOrNull(state.error);
      }
      if (Option.isNone(state.snapshot)) {
        continue;
      }
      hasSnapshot = true;
      const updatedAt = state.snapshot.value.updatedAt;
      if (latestSnapshotUpdatedAt === null || updatedAt > latestSnapshotUpdatedAt) {
        latestSnapshotUpdatedAt = updatedAt;
      }
    }

    const next: EnvironmentShellSummary = {
      hasSnapshot,
      hasSynchronizingShell,
      hasCachedShell,
      hasLiveShell,
      firstError,
      latestSnapshotUpdatedAt,
    };
    if (shellSummariesEqual(previousSummary, next)) {
      return previousSummary;
    }
    previousSummary = next;
    return previousSummary;
  }).pipe(Atom.withLabel("environment-shell-summary"));
}

export function createEnvironmentServerConfigsAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly serverConfigValueAtom: (environmentId: EnvironmentId) => Atom.Atom<ServerConfig | null>;
}) {
  let previousServerConfigs = EMPTY_SERVER_CONFIGS;
  return Atom.make((get) => {
    const next = new Map<EnvironmentId, ServerConfig>();
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      const config = get(input.serverConfigValueAtom(environmentId));
      if (config !== null) {
        next.set(environmentId, config);
      }
    }
    if (mapsEqual(previousServerConfigs, next)) {
      return previousServerConfigs;
    }
    previousServerConfigs = next;
    return previousServerConfigs;
  }).pipe(Atom.withLabel("environment-server-configs"));
}

export function createEnvironmentShellAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | EnvironmentCacheStore | ShellSnapshotLoader | R,
    E
  >,
) {
  const stateAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(shellStateChanges(environmentId), {
      initialValue: EMPTY_SHELL_STATE,
    }),
  );

  const stateValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      Option.getOrElse(AsyncResult.value(get(stateAtom(environmentId))), () => EMPTY_SHELL_STATE),
    ).pipe(Atom.withLabel(`environment-shell-state-value:${environmentId}`)),
  );

  return {
    stateAtom,
    stateValueAtom,
  };
}

export * from "./models.ts";
export * from "./shellCommands.ts";
export * from "./shellReducer.ts";
export * from "./shellSnapshotHttp.ts";
export * from "./snapshots.ts";
