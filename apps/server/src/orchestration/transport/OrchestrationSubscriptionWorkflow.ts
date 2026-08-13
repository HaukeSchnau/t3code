import {
  OrchestrationGetSnapshotError,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationShellCursorItem,
  type OrchestrationShellStreamItem,
  type OrchestrationSubscribeShellInput,
  type OrchestrationSubscribeThreadInput,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { projectActivityEvent, projectThreadDetailSnapshot } from "../ActivityPayloadProjection.ts";
import { planReplay, type ReplayThresholds } from "../ReplayPlanner.ts";
import type * as OrchestrationEngine from "../Services/OrchestrationEngine.ts";
import type * as ProjectionSnapshotMaterializer from "../Services/ProjectionSnapshotMaterializer.ts";
import type * as ProjectionSnapshotQuery from "../Services/ProjectionSnapshotQuery.ts";
import { isShellVisibleThreadEvent } from "../shellVisibility.ts";
import {
  incrementWorkloadCounter,
  adjustWorkloadGauge,
} from "../../diagnostics/WorkloadDiagnostics.ts";
import * as ReplayLogPublisher from "../../observability/ReplayLogPublisher.ts";
import {
  makeReplayObserver,
  replayCatchUpWithLive,
  type ReplayObserver,
} from "../../observability/ReplayObservability.ts";

const SHELL_CURSOR_COMPACTION_INTERVAL = 128;
const SHELL_REPLAY_PAGE_SIZE = 50;
const SHELL_RESUME_MAX_GAP = 1_000;
const THREAD_RESUME_MAX_GAP = 1_000;
const LIVE_REPLAY_BUFFER_SIZE = 1_024;
const SHELL_REFETCH_CONCURRENCY = 8;
const SHELL_COALESCE_WINDOW = Duration.millis(50);
const SHELL_COALESCE_MAX_CHUNK = 512;
const SHELL_REPLAY_THRESHOLDS: ReplayThresholds = {
  maxEvents: 1_024,
  maxPayloadBytes: 4 * 1024 * 1024,
};

type ShellDeltaItem = Exclude<OrchestrationShellStreamItem, { readonly kind: "snapshot" }>;
type ShellLiveItem = Exclude<ShellDeltaItem, { readonly kind: "synchronized" }>;
type ShellCatchUpItem =
  | ShellLiveItem
  | Extract<OrchestrationShellStreamItem, { readonly kind: "snapshot" }>;
type ThreadBufferedItem = Exclude<OrchestrationThreadStreamItem, { readonly kind: "snapshot" }>;
type ShellLiveInput =
  | { readonly kind: "event"; readonly event: OrchestrationEvent }
  | { readonly kind: "synchronized" };

export function isThreadDetailEvent(event: OrchestrationEvent): event is Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.proposed-plan-upserted"
      | "thread.activity-appended"
      | "thread.turn-diff-completed"
      | "thread.reverted"
      | "thread.history-pruned"
      | "thread.session-set";
  }
> {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.message-queued" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.queued-message-deleted" ||
    event.type === "thread.queued-message-dispatched" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.history-pruned" ||
    event.type === "thread.session-set"
  );
}

function getReplayProbeCapability(
  engine: OrchestrationEngine.OrchestrationEngineShape,
): NonNullable<OrchestrationEngine.OrchestrationEngineShape["replayProbeCapability"]> | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(engine, "replayProbeCapability");
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  const capability = descriptor.value as unknown;
  if (
    typeof capability !== "object" ||
    capability === null ||
    !("kind" in capability) ||
    capability.kind !== "payload-free-v1"
  ) {
    return undefined;
  }
  return capability as NonNullable<
    OrchestrationEngine.OrchestrationEngineShape["replayProbeCapability"]
  >;
}

function getLiveSubscriptionCapability(
  engine: OrchestrationEngine.OrchestrationEngineShape,
):
  | NonNullable<OrchestrationEngine.OrchestrationEngineShape["liveSubscriptionCapability"]>
  | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(engine, "liveSubscriptionCapability");
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  const capability = descriptor.value as unknown;
  if (
    typeof capability !== "object" ||
    capability === null ||
    !("kind" in capability) ||
    capability.kind !== "scoped-v1"
  ) {
    return undefined;
  }
  return capability as NonNullable<
    OrchestrationEngine.OrchestrationEngineShape["liveSubscriptionCapability"]
  >;
}

export function shouldIncludeShellStreamItem(
  item: OrchestrationShellStreamItem,
  includeCursorItems: boolean | undefined,
): boolean {
  return item.kind !== "cursor" || includeCursorItems === true;
}

/**
 * Bound sequence-only traffic without delaying shell-visible changes. A finite
 * catch-up stream flushes its final cursor so the client resumes from its true
 * tail; a live stream emits progress at a fixed event-count cadence.
 */
export function compactShellCursorItems<E, R>(
  stream: Stream.Stream<ShellDeltaItem, E, R>,
  interval = SHELL_CURSOR_COMPACTION_INTERVAL,
): Stream.Stream<ShellDeltaItem, E, R> {
  const boundedInterval = Math.max(1, Math.floor(interval));
  interface CursorCompactionState {
    readonly count: number;
    readonly pending: OrchestrationShellCursorItem | null;
  }
  const initial = (): CursorCompactionState => ({ count: 0, pending: null });
  const compact = (
    state: CursorCompactionState,
    item: ShellDeltaItem,
  ): readonly [CursorCompactionState, ReadonlyArray<ShellDeltaItem>] => {
    if (item.kind !== "cursor") {
      incrementWorkloadCounter("shell.suppressed", state.count);
      return [initial(), [item]];
    }
    const count = state.count + 1;
    if (count >= boundedInterval) {
      incrementWorkloadCounter("shell.suppressed", state.count);
      return [initial(), [item]];
    }
    return [{ count, pending: item }, []];
  };
  return Stream.mapAccum<ShellDeltaItem, E, R, CursorCompactionState, ShellDeltaItem>(
    stream,
    initial,
    compact,
    {
      onHalt: (state) => (state.pending === null ? [] : [state.pending]),
    },
  );
}

export function makeOrchestrationSubscriptionWorkflow(input: {
  readonly orchestrationEngine: OrchestrationEngine.OrchestrationEngineShape;
  readonly projectionSnapshotQuery: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape;
  readonly projectionSnapshotMaterializer: ProjectionSnapshotMaterializer.ProjectionSnapshotMaterializerShape;
  readonly replayLogPublisher: ReplayLogPublisher.ReplayLogPublisher["Service"];
}) {
  const readEventsPaginated = (afterSequence: number, observer: ReplayObserver) =>
    Stream.paginate(afterSequence, (cursor) =>
      Stream.runCollect(input.orchestrationEngine.readEvents(cursor, SHELL_REPLAY_PAGE_SIZE)).pipe(
        Effect.map((chunk) => {
          const events = Array.from(chunk);
          observer.recordBatch(events);
          const lastEvent = events.at(-1);
          return [
            events,
            events.length === SHELL_REPLAY_PAGE_SIZE && lastEvent !== undefined
              ? Option.some(lastEvent.sequence)
              : Option.none<number>(),
          ] as const;
        }),
      ),
    );

  const shellCursor = (event: OrchestrationEvent): OrchestrationShellCursorItem => ({
    kind: "cursor",
    sequence: event.sequence,
  });

  const retryShellProjectionRead = <A, E>(
    aggregateKind: "project" | "provider" | "thread",
    aggregateId: string,
    read: Effect.Effect<A, E>,
  ): Effect.Effect<Option.Option<A>, never, never> =>
    read.pipe(
      Effect.retry({ times: 1 }),
      Effect.map(Option.some),
      Effect.tapError((error) =>
        Effect.logWarning("orchestration shell projection refetch failed", {
          aggregateKind,
          aggregateId,
          error,
        }),
      ),
      Effect.orElseSucceed(() => Option.none()),
    );

  const projectUpsertOrRemove = (
    projectId: ProjectId,
    sequence: number,
  ): Effect.Effect<Option.Option<ShellLiveItem>, never, never> =>
    retryShellProjectionRead(
      "project",
      projectId,
      input.projectionSnapshotQuery.getProjectShellById(projectId),
    ).pipe(
      Effect.map(
        Option.flatMap((project) =>
          Option.match(project, {
            onNone: () => Option.some<ShellLiveItem>({ kind: "cursor", sequence }),
            onSome: (project) =>
              Option.some<ShellLiveItem>({ kind: "project-upserted", sequence, project }),
          }),
        ),
      ),
    );

  const threadUpsertOrRemove = (
    threadId: ThreadId,
    sequence: number,
  ): Effect.Effect<Option.Option<ShellLiveItem>, never, never> =>
    retryShellProjectionRead(
      "thread",
      threadId,
      input.projectionSnapshotQuery.getThreadShellById(threadId),
    ).pipe(
      Effect.map(
        Option.flatMap((thread) =>
          Option.match(thread, {
            onNone: () => Option.some<ShellLiveItem>({ kind: "cursor", sequence }),
            onSome: (thread) =>
              Option.some<ShellLiveItem>({ kind: "thread-upserted", sequence, thread }),
          }),
        ),
      ),
    );

  const providerUsageLimitsUpsert = (
    event: Extract<OrchestrationEvent, { type: "provider.usage-limits-updated" }>,
  ): Effect.Effect<Option.Option<ShellLiveItem>, never, never> => {
    const fallback = {
      provider: event.payload.provider,
      providerInstanceId: event.payload.providerInstanceId,
      usageLimits: event.payload.usageLimits,
    };
    const read = input.projectionSnapshotQuery.getProviderUsageLimitsByInstanceId;
    if (!read) {
      return Effect.succeed(
        Option.some({
          kind: "usage-limits-updated",
          sequence: event.sequence,
          usageLimits: fallback,
        }),
      );
    }

    return retryShellProjectionRead(
      "provider",
      event.payload.providerInstanceId,
      read(event.payload.providerInstanceId),
    ).pipe(
      Effect.map((result) =>
        Option.some({
          kind: "usage-limits-updated" as const,
          sequence: event.sequence,
          usageLimits: Option.flatMap(result, (value) => value).pipe(
            Option.getOrElse(() => fallback),
          ),
        }),
      ),
    );
  };

  const toShellStreamEvent = (
    event: OrchestrationEvent,
  ): Effect.Effect<Option.Option<ShellLiveItem>, never, never> => {
    switch (event.type) {
      case "project.created":
      case "project.meta-updated":
        return projectUpsertOrRemove(event.payload.projectId, event.sequence);
      case "project.deleted":
        return Effect.succeed(
          Option.some({
            kind: "project-removed" as const,
            sequence: event.sequence,
            projectId: event.payload.projectId,
          }),
        );
      case "thread.deleted":
      case "thread.archived":
        return Effect.succeed(
          Option.some({
            kind: "thread-removed" as const,
            sequence: event.sequence,
            threadId: event.payload.threadId,
          }),
        );
      case "thread.unarchived":
        return threadUpsertOrRemove(event.payload.threadId, event.sequence);
      case "provider.usage-limits-updated":
        return providerUsageLimitsUpsert(event);
      default:
        if (event.aggregateKind !== "thread" || !isShellVisibleThreadEvent(event)) {
          return Effect.succeed(Option.some(shellCursor(event)));
        }
        return threadUpsertOrRemove(ThreadId.make(event.aggregateId), event.sequence);
    }
  };

  const coalesceShellEvents = (
    events: ReadonlyArray<OrchestrationEvent>,
  ): Effect.Effect<ReadonlyArray<ShellLiveItem>, never, never> =>
    Effect.gen(function* () {
      if (events.length === 0) return [];
      const latestByAggregate = new Map<string, OrchestrationEvent>();
      const deletedAggregates = new Set<string>();
      for (const event of events) {
        const aggregateKey = `${event.aggregateKind}:${event.aggregateId}`;
        latestByAggregate.set(aggregateKey, event);
        if (
          event.type === "thread.deleted" ||
          event.type === "thread.archived" ||
          event.type === "project.deleted"
        ) {
          deletedAggregates.add(aggregateKey);
        }
      }
      const survivors = Array.from(latestByAggregate.values()).sort(
        (left, right) => left.sequence - right.sequence,
      );
      const shellEvents = yield* Effect.forEach(survivors, toShellStreamEvent, {
        concurrency: SHELL_REFETCH_CONCURRENCY,
      });
      return shellEvents.flatMap((option, index) => {
        if (Option.isNone(option)) return [];
        const item = option.value;
        const survivor = survivors[index];
        if (
          item.kind !== "cursor" ||
          survivor === undefined ||
          !deletedAggregates.has(`${survivor.aggregateKind}:${survivor.aggregateId}`)
        ) {
          return [item];
        }
        return survivor.aggregateKind === "project"
          ? [
              {
                kind: "project-removed" as const,
                sequence: survivor.sequence,
                projectId: ProjectId.make(survivor.aggregateId),
              },
            ]
          : [
              {
                kind: "thread-removed" as const,
                sequence: survivor.sequence,
                threadId: ThreadId.make(survivor.aggregateId),
              },
            ];
      });
    });

  const coalesceShellStream = <E, R>(
    stream: Stream.Stream<OrchestrationEvent, E, R>,
  ): Stream.Stream<ShellLiveItem, E, R> =>
    stream.pipe(
      Stream.groupedWithin(SHELL_COALESCE_MAX_CHUNK, SHELL_COALESCE_WINDOW),
      Stream.mapEffect(coalesceShellEvents),
      Stream.flatMap((items) => Stream.fromIterable(items)),
    );

  const coalesceShellLiveInputs = (
    inputs: ReadonlyArray<ShellLiveInput>,
  ): Effect.Effect<ReadonlyArray<ShellDeltaItem>, never, never> =>
    Effect.gen(function* () {
      const output: Array<ShellDeltaItem> = [];
      let pendingEvents: Array<OrchestrationEvent> = [];
      for (const item of inputs) {
        if (item.kind === "event") {
          pendingEvents.push(item.event);
          continue;
        }
        output.push(...(yield* coalesceShellEvents(pendingEvents)));
        pendingEvents = [];
        output.push({ kind: "synchronized" });
      }
      output.push(...(yield* coalesceShellEvents(pendingEvents)));
      return output;
    });

  const coalesceShellLiveStream = <E, R>(
    stream: Stream.Stream<ShellLiveInput, E, R>,
  ): Stream.Stream<ShellDeltaItem, E, R> =>
    stream.pipe(
      Stream.groupedWithin(SHELL_COALESCE_MAX_CHUNK, SHELL_COALESCE_WINDOW),
      Stream.mapEffect(coalesceShellLiveInputs),
      Stream.flatMap((items) => Stream.fromIterable(items)),
    );

  const subscribeShell = (subscriptionInput: OrchestrationSubscribeShellInput) =>
    Effect.gen(function* () {
      const liveBuffer = yield* Queue.unbounded<ShellLiveInput>();
      yield* Effect.forkScoped(
        input.orchestrationEngine.streamDomainEvents.pipe(
          Stream.runForEach((event) => Queue.offer(liveBuffer, { kind: "event" as const, event })),
        ),
        { startImmediately: true },
      );
      const bufferedLiveStream = compactShellCursorItems(
        coalesceShellLiveStream(Stream.fromQueue(liveBuffer)),
      );

      const loadSnapshot = input.projectionSnapshotQuery.getShellSnapshot().pipe(
        Effect.tapError((cause) =>
          Effect.logError("orchestration shell snapshot load failed", { cause }),
        ),
        Effect.mapError(
          (cause) =>
            new OrchestrationGetSnapshotError({
              message: "Failed to load orchestration shell snapshot",
              cause,
            }),
        ),
      );

      const synchronizedThenLive =
        subscriptionInput.requestCompletionMarker === true
          ? Stream.concat(
              Stream.fromEffect(
                Queue.offer(liveBuffer, { kind: "synchronized" as const }).pipe(
                  Effect.andThen(Queue.takeAll(liveBuffer)),
                  Effect.flatMap(coalesceShellLiveInputs),
                ),
              ).pipe(Stream.flatMap((items) => Stream.fromIterable(items))),
              bufferedLiveStream,
            )
          : bufferedLiveStream;

      if (subscriptionInput.afterSequence !== undefined) {
        const afterSequence = subscriptionInput.afterSequence;
        return replayCatchUpWithLive({
          observer: makeReplayObserver("shell", afterSequence).pipe(
            Effect.provideService(ReplayLogPublisher.ReplayLogPublisher, input.replayLogPublisher),
          ),
          live: bufferedLiveStream.pipe(
            Stream.filter((item): item is ShellLiveItem => item.kind !== "synchronized"),
          ),
          sequence: (item: ShellCatchUpItem) =>
            item.kind === "snapshot" ? item.snapshot.snapshotSequence : item.sequence,
          bufferCapacity: LIVE_REPLAY_BUFFER_SIZE,
          ...(subscriptionInput.requestCompletionMarker === true
            ? { synchronized: () => ({ kind: "synchronized" as const }) }
            : {}),
          catchUp: (observer) => {
            const replayFrom = (sequence: number) =>
              readEventsPaginated(sequence, observer).pipe(
                coalesceShellStream,
                compactShellCursorItems,
                Stream.filter((item): item is ShellLiveItem => item.kind !== "synchronized"),
                Stream.mapError(
                  (cause) =>
                    new OrchestrationGetSnapshotError({
                      message: "Failed to replay orchestration shell events",
                      cause,
                    }),
                ),
              );
            const probeCapability = getReplayProbeCapability(input.orchestrationEngine);
            if (probeCapability === undefined) {
              return Stream.unwrap(
                Effect.gen(function* () {
                  const authoritativeHead = yield* input.orchestrationEngine.latestSequence.pipe(
                    Effect.mapError(
                      (cause) =>
                        new OrchestrationGetSnapshotError({
                          message: "Failed to read orchestration sequence",
                          cause,
                        }),
                    ),
                  );
                  const mustReplaceCursor =
                    afterSequence > authoritativeHead ||
                    authoritativeHead - afterSequence > SHELL_RESUME_MAX_GAP;
                  if (!mustReplaceCursor) {
                    observer.recordStrategy({
                      strategy: "events",
                      reason: "capability-unavailable",
                      probeEventCount: 0,
                      probePayloadBytes: 0,
                    });
                    return replayFrom(afterSequence);
                  }
                  const snapshot = yield* loadSnapshot;
                  observer.recordStrategy({
                    strategy: "snapshot",
                    reason: afterSequence > authoritativeHead ? "bounded" : "event-count",
                    probeEventCount: Math.max(0, authoritativeHead - afterSequence),
                    probePayloadBytes: 0,
                    snapshotSequence: snapshot.snapshotSequence,
                  });
                  const snapshotItem: ShellCatchUpItem = { kind: "snapshot", snapshot };
                  const snapshotStream = Stream.make(snapshotItem);
                  return snapshot.snapshotSequence >= authoritativeHead
                    ? snapshotStream
                    : Stream.concat(snapshotStream, replayFrom(snapshot.snapshotSequence));
                }),
              );
            }
            return Stream.unwrap(
              Effect.gen(function* () {
                const probeResult = yield* Effect.result(
                  probeCapability.probeReplay(afterSequence, SHELL_REPLAY_THRESHOLDS.maxEvents),
                );
                if (probeResult._tag === "Failure") {
                  yield* Effect.logWarning(
                    "orchestration shell replay probe failed; using exact event replay",
                    { cause: probeResult.failure, afterSequence },
                  );
                  observer.recordStrategy({
                    strategy: "events",
                    reason: "probe-failed",
                    probeEventCount: 0,
                    probePayloadBytes: 0,
                  });
                  return replayFrom(afterSequence);
                }
                const probe = probeResult.success;
                const plan = planReplay(probe, SHELL_REPLAY_THRESHOLDS);
                if (plan.strategy === "events") {
                  observer.recordStrategy({
                    strategy: "events",
                    reason: plan.reason,
                    probeEventCount: probe.eventCount,
                    probePayloadBytes: probe.payloadBytes,
                  });
                  return replayFrom(afterSequence);
                }
                const snapshotResult = yield* Effect.result(loadSnapshot);
                if (snapshotResult._tag === "Failure") {
                  yield* Effect.logWarning(
                    "orchestration shell replay snapshot failed; using exact event replay",
                    { cause: snapshotResult.failure, afterSequence },
                  );
                  observer.recordStrategy({
                    strategy: "events",
                    reason: "snapshot-failed",
                    probeEventCount: probe.eventCount,
                    probePayloadBytes: probe.payloadBytes,
                  });
                  return replayFrom(afterSequence);
                }
                const snapshot = snapshotResult.success;
                if (snapshot.snapshotSequence <= afterSequence) {
                  observer.recordStrategy({
                    strategy: "events",
                    reason: "snapshot-stale",
                    probeEventCount: probe.eventCount,
                    probePayloadBytes: probe.payloadBytes,
                  });
                  return replayFrom(afterSequence);
                }
                observer.recordStrategy({
                  strategy: "snapshot",
                  reason: plan.reason,
                  probeEventCount: probe.eventCount,
                  probePayloadBytes: probe.payloadBytes,
                  snapshotSequence: snapshot.snapshotSequence,
                });
                const snapshotItem: ShellCatchUpItem = { kind: "snapshot", snapshot };
                return Stream.concat(
                  Stream.make(snapshotItem),
                  replayFrom(snapshot.snapshotSequence),
                );
              }),
            );
          },
        });
      }

      const snapshot = yield* loadSnapshot;
      return Stream.concat(
        Stream.make({ kind: "snapshot" as const, snapshot }),
        synchronizedThenLive,
      );
    });

  const subscribeThread = (subscriptionInput: OrchestrationSubscribeThreadInput) =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => adjustWorkloadGauge("subscriptions.detail.active", 1)),
        () => Effect.sync(() => adjustWorkloadGauge("subscriptions.detail.active", -1)),
      );
      const isThisThreadDetailEvent = (event: OrchestrationEvent) =>
        event.aggregateKind === "thread" &&
        event.aggregateId === subscriptionInput.threadId &&
        isThreadDetailEvent(event);

      const liveSubscription = getLiveSubscriptionCapability(input.orchestrationEngine);
      const acquiredLiveEvents = yield* (
        liveSubscription?.subscribe ?? Effect.succeed(input.orchestrationEngine.streamDomainEvents)
      );
      const liveStream = acquiredLiveEvents.pipe(
        Stream.filter(isThisThreadDetailEvent),
        Stream.tap(() =>
          Effect.sync(() => incrementWorkloadCounter("thread_detail.events_published")),
        ),
        Stream.map((event) => ({
          kind: "event" as const,
          event: projectActivityEvent(event),
        })),
      );

      const liveBuffer = yield* Queue.unbounded<ThreadBufferedItem>();
      yield* Effect.forkScoped(
        liveStream.pipe(Stream.runForEach((item) => Queue.offer(liveBuffer, item))),
      );
      const bufferedLiveStream = Stream.fromQueue(liveBuffer);

      if (subscriptionInput.afterSequence !== undefined) {
        const afterSequence = subscriptionInput.afterSequence;
        const headSequence = yield* input.orchestrationEngine.latestSequence;
        const replayGap = headSequence - afterSequence;
        if (replayGap >= 0 && replayGap <= THREAD_RESUME_MAX_GAP) {
          const catchUpStream = input.orchestrationEngine.readEvents(afterSequence, replayGap).pipe(
            Stream.filter(isThisThreadDetailEvent),
            Stream.map((event) => ({
              kind: "event" as const,
              event: projectActivityEvent(event),
            })),
            Stream.mapError(
              (cause) =>
                new OrchestrationGetSnapshotError({
                  message: `Failed to replay thread ${subscriptionInput.threadId} events`,
                  cause,
                }),
            ),
          );
          const afterCatchUp =
            subscriptionInput.requestCompletionMarker === true
              ? Stream.concat(
                  Stream.fromEffect(
                    Queue.offer(liveBuffer, { kind: "synchronized" as const }),
                  ).pipe(Stream.drain),
                  bufferedLiveStream,
                )
              : bufferedLiveStream;
          return Stream.concat(catchUpStream, afterCatchUp);
        }
      }

      const snapshot = yield* input.projectionSnapshotMaterializer
        .getThreadDetailSnapshot(
          subscriptionInput.threadId,
          subscriptionInput.activityDetailMode ?? "full",
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetSnapshotError({
                message: `Failed to load thread ${subscriptionInput.threadId}`,
                cause,
              }),
          ),
        );
      if (Option.isNone(snapshot)) {
        return yield* new OrchestrationGetSnapshotError({
          message: `Thread ${subscriptionInput.threadId} was not found`,
          cause: subscriptionInput.threadId,
        });
      }
      const afterSnapshot =
        subscriptionInput.requestCompletionMarker === true
          ? Stream.concat(
              Stream.fromEffect(Queue.offer(liveBuffer, { kind: "synchronized" as const })).pipe(
                Stream.drain,
              ),
              bufferedLiveStream,
            )
          : bufferedLiveStream;
      return Stream.concat(
        Stream.make({
          kind: "snapshot" as const,
          snapshot: projectThreadDetailSnapshot(snapshot.value),
        }),
        afterSnapshot,
      );
    });

  return { subscribeShell, subscribeThread };
}
