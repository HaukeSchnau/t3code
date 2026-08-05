import {
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId as EnvironmentIdType,
  type OrchestrationThread,
  type OrchestrationThreadActivityDetailMode,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { subscribeWithSessionDynamic } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import { ThreadSnapshotLoader } from "./threadSnapshotHttp.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { applyThreadDetailEvent } from "./threadReducer.ts";
import { THREAD_STATE_IDLE_TTL_MS } from "./threadRetention.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  type EnvironmentThreadStatus,
} from "./threadState.ts";

export const AUTHORITATIVE_REFRESH_MAX_ATTEMPTS = 5;
export const AUTHORITATIVE_REFRESH_RETRY_BASE_MS = 200;
export const AUTHORITATIVE_REFRESH_RETRY_CAP_MS = 2_000;

function authoritativeRefreshJitterHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Stable for one client seed, de-correlated across independently seeded states. */
export function authoritativeRefreshRetryDelayMs(input: {
  readonly attempt: number;
  readonly eventSequence: number;
  readonly clientSeed: number;
  readonly environmentId: string;
  readonly threadId: string;
}): number {
  const exponential = Math.min(
    AUTHORITATIVE_REFRESH_RETRY_CAP_MS,
    AUTHORITATIVE_REFRESH_RETRY_BASE_MS * 2 ** Math.max(0, input.attempt),
  );
  const jitterRadius = Math.floor(exponential * 0.2);
  const jitterSpan = jitterRadius * 2 + 1;
  const jitterKey = [
    input.clientSeed,
    input.environmentId,
    input.threadId,
    input.eventSequence,
    input.attempt,
  ].join(":");
  const jitter = (authoritativeRefreshJitterHash(jitterKey) % jitterSpan) - jitterRadius;
  return Math.max(0, Math.min(AUTHORITATIVE_REFRESH_RETRY_CAP_MS, exponential + jitter));
}

class AuthoritativeRefreshRestart extends Data.TaggedError("AuthoritativeRefreshRestart")<{
  readonly reason: "generation-changed" | "retries-exhausted";
}> {}

function statusWithoutLiveData(data: Option.Option<OrchestrationThread>): EnvironmentThreadStatus {
  return Option.isSome(data) ? "cached" : "empty";
}

function formatThreadError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not synchronize the thread.";
}

function shouldPersistThread(thread: OrchestrationThread): boolean {
  const status = thread.session?.status;
  return status !== "starting" && status !== "running";
}

export const makeEnvironmentThreadState = Effect.fn("EnvironmentThreadState.make")(function* (
  threadId: ThreadIdType,
  activityDetailMode: OrchestrationThreadActivityDetailMode = "full",
  options: { readonly authoritativeRefreshJitterSeed?: number } = {},
) {
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const snapshotLoader = yield* ThreadSnapshotLoader;
  const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
  const environmentId = supervisor.target.environmentId;
  const authoritativeRefreshJitterSeed =
    options.authoritativeRefreshJitterSeed ?? (yield* Random.nextInt) >>> 0;
  const loadedCache = yield* cache.loadThread(environmentId, threadId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not load cached thread.").pipe(
        Effect.annotateLogs({
          environmentId,
          threadId,
          error: error.message,
        }),
        Effect.as(Option.none<OrchestrationThreadDetailSnapshot>()),
      ),
    ),
  );
  const cached = Option.filter(
    loadedCache,
    (snapshot) => snapshot.activityDetailMode === activityDetailMode,
  );
  const cachedThread = Option.map(cached, (snapshot) => snapshot.thread);
  const state = yield* SubscriptionRef.make<EnvironmentThreadState>({
    data: cachedThread,
    status: statusWithoutLiveData(cachedThread),
    error: Option.none(),
  });
  // Seed the resume cursor from the cached snapshot so a warm cache can catch up
  // via `afterSequence` instead of re-downloading the full thread body.
  const lastSequence = yield* SubscriptionRef.make(
    Option.match(cached, {
      onNone: () => 0,
      onSome: (snapshot) => snapshot.snapshotSequence,
    }),
  );
  const awaitingCompletion = yield* Ref.make(false);
  const persistence = yield* Queue.sliding<OrchestrationThreadDetailSnapshot>(1);
  const subscriptionSynchronization = yield* Ref.make({
    generation: -1,
    session: null as RpcSession | null,
    synchronized: false,
  });
  const latestConnectionGeneration = yield* Ref.make(-1);

  const persist = Effect.fn("EnvironmentThreadState.persist")(function* (
    snapshot: OrchestrationThreadDetailSnapshot,
  ) {
    yield* cache.saveThread(environmentId, snapshot).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not persist the thread cache.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
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

  const setSynchronizing = SubscriptionRef.update(state, (current) =>
    current.status === "deleted"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const markGenerationUnsynchronized = (generation: number) =>
    Ref.update(subscriptionSynchronization, (current) =>
      current.generation < generation
        ? { generation, session: null, synchronized: false }
        : current,
    );
  const setReady = (generation: number) =>
    Effect.all([
      Ref.get(subscriptionSynchronization),
      SubscriptionRef.get(supervisor.session),
    ]).pipe(
      Effect.flatMap(([synchronization, currentSession]) =>
        SubscriptionRef.update(state, (current) =>
          current.status === "live" ||
          current.status === "deleted" ||
          (synchronization.generation === generation &&
            synchronization.synchronized &&
            Option.isSome(currentSession) &&
            synchronization.session === currentSession.value &&
            Option.isSome(current.data))
            ? current
            : { ...current, status: "synchronizing" as const, error: Option.none() },
        ),
      ),
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
          status:
            current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
        })),
      ),
    );
  const setStreamError = (cause: Cause.Cause<unknown>) =>
    Ref.set(awaitingCompletion, false).pipe(
      Effect.andThen(
        SubscriptionRef.update(state, (current) => ({
          ...current,
          status:
            current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
          error: Option.some(formatThreadError(cause)),
        })),
      ),
    );

  const setThread = Effect.fn("EnvironmentThreadState.setThread")(function* (
    thread: OrchestrationThread,
  ) {
    const waiting = yield* Ref.get(awaitingCompletion);
    yield* SubscriptionRef.set(state, {
      data: Option.some(thread),
      status: waiting ? "synchronizing" : "live",
      error: Option.none(),
    });
    // Active threads can update many times per second and retain large tool
    // payloads. The server remains the source of truth while a turn is active;
    // persist once it settles so cache encoding stays off the streaming path.
    if (shouldPersistThread(thread)) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      yield* Queue.offer(persistence, { snapshotSequence, activityDetailMode, thread });
    }
  });

  const setDeleted = Effect.fn("EnvironmentThreadState.setDeleted")(function* () {
    yield* Ref.set(awaitingCompletion, false);
    yield* SubscriptionRef.set(state, {
      data: Option.none(),
      status: "deleted",
      error: Option.none(),
    });
    yield* cache.removeThread(environmentId, threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not remove the cached thread.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  const reloadAuthoritativeSnapshot = Effect.fn(
    "EnvironmentThreadState.reloadAuthoritativeSnapshot",
  )(function* (
    minimumSequence: number,
    itemSession: RpcSession | undefined,
    itemGeneration: number | undefined,
  ) {
    // Keep the event cursor pinned before the ambiguous event until a compact
    // snapshot that includes it is available. The socket stream is processed
    // sequentially, so replacing state and advancing to the snapshot cursor is
    // atomic with respect to later streamed events; queued duplicates are then
    // ignored by the normal sequence check.
    const ensureCurrentGeneration = Effect.fn(
      "EnvironmentThreadState.ensureAuthoritativeRefreshGeneration",
    )(function* () {
      if (itemSession === undefined || itemGeneration === undefined) return;
      const [currentSession, connectionState] = yield* Effect.all([
        SubscriptionRef.get(supervisor.session),
        SubscriptionRef.get(supervisor.state),
      ]);
      if (
        Option.isNone(currentSession) ||
        currentSession.value !== itemSession ||
        connectionState.generation !== itemGeneration
      ) {
        return yield* new AuthoritativeRefreshRestart({ reason: "generation-changed" });
      }
    });

    const waitForRefreshSourceChange =
      itemSession === undefined || itemGeneration === undefined
        ? Effect.never
        : Effect.raceFirst(
            SubscriptionRef.changes(supervisor.state).pipe(
              Stream.filter((connectionState) => connectionState.generation !== itemGeneration),
              Stream.runHead,
            ),
            SubscriptionRef.changes(supervisor.session).pipe(
              Stream.filter(
                (currentSession) =>
                  Option.isNone(currentSession) || currentSession.value !== itemSession,
              ),
              Stream.runHead,
            ),
          ).pipe(
            Effect.flatMap(() =>
              Effect.fail(new AuthoritativeRefreshRestart({ reason: "generation-changed" })),
            ),
          );

    for (let attempt = 0; attempt < AUTHORITATIVE_REFRESH_MAX_ATTEMPTS; attempt += 1) {
      yield* ensureCurrentGeneration();
      const prepared = yield* SubscriptionRef.get(supervisor.prepared);
      if (Option.isSome(prepared)) {
        const outcome = yield* Effect.raceFirst(
          snapshotLoader.load(prepared.value, threadId, activityDetailMode),
          waitForRefreshSourceChange,
        );
        // The request may have completed in the same scheduler turn as a
        // reconnect. Recheck identity before interpreting Found, NotFound, or
        // TransientFailure so no stale outcome can mutate or alarm new state.
        yield* ensureCurrentGeneration();
        if (outcome._tag === "NotFound") {
          yield* setDeleted();
          return;
        }
        if (outcome._tag === "Found") {
          const snapshot = outcome.snapshot;
          if (
            snapshot.activityDetailMode === activityDetailMode &&
            snapshot.snapshotSequence >= minimumSequence
          ) {
            yield* SubscriptionRef.set(lastSequence, snapshot.snapshotSequence);
            yield* setThread(snapshot.thread);
            return;
          }
          yield* setStreamError(
            Cause.fail(
              new Error(
                `Authoritative thread snapshot is stale (sequence ${snapshot.snapshotSequence}, expected at least ${minimumSequence}).`,
              ),
            ),
          );
        } else {
          yield* setStreamError(Cause.fail(new Error(outcome.message)));
        }
      }
      if (attempt === AUTHORITATIVE_REFRESH_MAX_ATTEMPTS - 1) {
        return yield* new AuthoritativeRefreshRestart({ reason: "retries-exhausted" });
      }
      const delay = authoritativeRefreshRetryDelayMs({
        attempt,
        eventSequence: minimumSequence,
        clientSeed: authoritativeRefreshJitterSeed,
        environmentId,
        threadId,
      });
      yield* Effect.raceFirst(Effect.sleep(delay), waitForRefreshSourceChange);
    }
  });

  const applyItem = Effect.fn("EnvironmentThreadState.applyItem")(function* (
    item: OrchestrationThreadStreamItem,
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
        Option.isSome(current.data) && current.status !== "deleted"
          ? { ...current, status: "live" as const, error: Option.none() }
          : current,
      );
      return;
    }

    if (item.kind === "snapshot") {
      yield* SubscriptionRef.set(lastSequence, item.snapshot.snapshotSequence);
      yield* setThread(item.snapshot.thread);
      return;
    }

    const sequence = yield* SubscriptionRef.get(lastSequence);
    if (item.event.sequence <= sequence) {
      return;
    }
    const current = yield* SubscriptionRef.get(state);
    if (Option.isNone(current.data)) {
      yield* SubscriptionRef.set(lastSequence, item.event.sequence);
      if (item.event.type === "thread.deleted" && current.status !== "deleted") {
        yield* setDeleted();
      }
      return;
    }
    const result = applyThreadDetailEvent(current.data.value, item.event, activityDetailMode);
    if (result.kind === "updated") {
      yield* SubscriptionRef.set(lastSequence, item.event.sequence);
      yield* setThread(result.thread);
    } else if (result.kind === "deleted") {
      yield* SubscriptionRef.set(lastSequence, item.event.sequence);
      yield* setDeleted();
    } else if (result.kind === "authoritative-refresh-required") {
      yield* reloadAuthoritativeSnapshot(item.event.sequence, itemSession, itemGeneration);
    } else {
      yield* SubscriptionRef.set(lastSequence, item.event.sequence);
    }
  });

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

  const foregroundResubscriptions = Option.match(wakeups, {
    onNone: () => Stream.never,
    onSome: (service) =>
      service.changes.pipe(Stream.filter(ConnectionWakeups.shouldResubscribeAfterWakeup)),
  });

  yield* setSynchronizing;
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      while (true) {
        yield* subscribeWithSessionDynamic(
          ORCHESTRATION_WS_METHODS.subscribeThread,
          Effect.fn("EnvironmentThreadState.makeSubscribeInput")(function* (session) {
            const supportsCompletionMarker = yield* session.initialConfig.pipe(
              Effect.map((config) => config.threadResumeCompletionMarker === true),
              Effect.orElseSucceed(() => false),
            );
            yield* Ref.set(awaitingCompletion, supportsCompletionMarker);
            yield* SubscriptionRef.update(state, (current) =>
              current.status === "deleted"
                ? current
                : { ...current, status: "synchronizing" as const },
            );

            let current = yield* SubscriptionRef.get(state);
            if (Option.isNone(current.data) && current.status !== "deleted") {
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
              const outcome = yield* snapshotLoader.load(prepared, threadId, activityDetailMode);
              if (outcome._tag === "Found") {
                yield* SubscriptionRef.set(lastSequence, outcome.snapshot.snapshotSequence);
                yield* setThread(outcome.snapshot.thread);
                current = yield* SubscriptionRef.get(state);
              }
            }

            const sequence = yield* SubscriptionRef.get(lastSequence);
            const canResume = Option.isSome(current.data);
            if (!supportsCompletionMarker && canResume) {
              yield* SubscriptionRef.update(state, (value) => ({
                ...value,
                status: value.status === "deleted" ? value.status : ("live" as const),
              }));
            }

            return {
              threadId,
              activityDetailMode,
              ...(canResume ? { afterSequence: sequence } : {}),
              ...(supportsCompletionMarker ? { requestCompletionMarker: true as const } : {}),
            };
          }),
          {
            admission: {
              group: "thread-detail-catch-up",
              maxConcurrent: 3,
              releaseWhen: (item) => item.kind === "synchronized",
            },
            onExpectedFailure: setStreamError,
            retryExpectedFailureAfter: "250 millis",
            resubscribe: foregroundResubscriptions,
          },
        ).pipe(
          Stream.runForEach((item) => applyItem(item.value, item.session, item.generation)),
          Effect.catchTag("AuthoritativeRefreshRestart", (error) =>
            Effect.logDebug("Restarting thread subscription for authoritative refresh.").pipe(
              Effect.annotateLogs({ threadId, reason: error.reason }),
              Effect.andThen(Effect.sleep("50 millis")),
            ),
          ),
        );
      }
    }),
  );

  yield* Effect.addFinalizer(() =>
    Effect.all([SubscriptionRef.get(state), SubscriptionRef.get(lastSequence)]).pipe(
      Effect.flatMap(([current, snapshotSequence]) =>
        Option.match(current.data, {
          onNone: () => Effect.void,
          onSome: (thread) =>
            shouldPersistThread(thread)
              ? persist({ snapshotSequence, activityDetailMode, thread })
              : Effect.void,
        }),
      ),
    ),
  );

  return state;
});

export function threadStateChanges(
  environmentId: EnvironmentIdType,
  threadId: ThreadIdType,
  activityDetailMode: OrchestrationThreadActivityDetailMode = "full",
) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(
      makeEnvironmentThreadState(threadId, activityDetailMode).pipe(
        Effect.map(SubscriptionRef.changes),
      ),
    ),
  );
}

export function createEnvironmentThreadStateAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | EnvironmentCacheStore | ThreadSnapshotLoader | R,
    E
  >,
  options: { readonly activityDetailMode?: OrchestrationThreadActivityDetailMode } = {},
) {
  const activityDetailMode = options.activityDetailMode ?? "full";
  const family = Atom.family((key: string) => {
    const { environmentId, threadId } = parseThreadKey(key);
    return runtime
      .atom(threadStateChanges(environmentId, threadId, activityDetailMode), {
        initialValue: EMPTY_ENVIRONMENT_THREAD_STATE,
      })
      .pipe(
        Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
        Atom.withLabel(`environment-thread-state:${key}`),
      );
  });

  return {
    stateAtom: (environmentId: EnvironmentIdType, threadId: ThreadIdType) =>
      family(threadKey({ environmentId, threadId })),
  };
}

export * from "./archivedThreads.ts";
export * from "./checkpointDiff.ts";
export * from "./threadSnapshotHttp.ts";
export * from "./composerPathSearch.ts";
export * from "./threadCommands.ts";
export * from "./threadDetail.ts";
export * from "./threadReducer.ts";
export * from "./threadShell.ts";
export * from "./threadState.ts";
