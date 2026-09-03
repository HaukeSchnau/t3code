import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Semaphore from "effect/Semaphore";

import { incrementWorkloadCounter, setWorkloadGauge } from "../diagnostics/WorkloadDiagnostics.ts";
import {
  providerTranscriptJournalBatchCharacterCount,
  providerTranscriptJournalBatchKind,
  type ProviderTranscriptJournalBatch,
} from "../orchestration/ProviderTranscriptJournalBatch.ts";
import type { ProviderTranscriptJournalEntry } from "../persistence/Services/ProviderTranscriptJournal.ts";
import { outcomeFromExit } from "./Attributes.ts";
import {
  metricAttributes,
  providerTranscriptJournalBatchCharacters,
  providerTranscriptJournalBatchDuration,
  providerTranscriptJournalBatchEvents,
  providerTranscriptJournalBatchesTotal,
  providerTranscriptJournalDepth,
  providerTranscriptJournalIngestionLag,
  providerTranscriptJournalOldestEventLag,
  providerTranscriptJournalSourceEventsTotal,
} from "./Metrics.ts";

export type TranscriptJournalIngestionPhase = "recovery" | "live";

function journalEventIdentity(event: ProviderTranscriptJournalEntry["event"]): string {
  return `${event.providerInstanceId ?? event.provider}\0${event.eventId}`;
}

interface JournalHeapNode {
  readonly identity: string;
  readonly createdAtMs: number;
  readonly token: number;
}

interface TrackedJournalEvent {
  readonly event: ProviderTranscriptJournalEntry["event"];
  readonly createdAtMs: number;
  readonly token: number;
}

interface RecoverySummary {
  readonly startedAtNanos: bigint;
  readonly expectedBatches: number;
  readonly expectedSourceEvents: number;
  completedBatches: number;
  failedBatches: number;
  completedSourceEvents: number;
  readonly failedEventIds: string[];
}

export interface TranscriptJournalTrackerDebugSnapshot {
  readonly hydrated: boolean;
  readonly depth: number;
  readonly oldestCreatedAtMs: number | null;
  readonly heapSize: number;
  readonly workUnits: number;
  readonly recoverySummaryLogs: number;
}

export interface TranscriptJournalTrackerShape {
  readonly hydrateOnce: (
    entries: ReadonlyArray<ProviderTranscriptJournalEntry>,
  ) => Effect.Effect<void>;
  readonly registerAccepted: (
    event: ProviderTranscriptJournalEntry["event"],
  ) => Effect.Effect<void>;
  readonly registerEntries: (
    entries: ReadonlyArray<ProviderTranscriptJournalEntry>,
  ) => Effect.Effect<void>;
  readonly removeSucceeded: (
    events: ReadonlyArray<ProviderTranscriptJournalEntry["event"]>,
  ) => Effect.Effect<void>;
  readonly beginRecovery: (input: {
    readonly batchCount: number;
    readonly sourceEventCount: number;
  }) => Effect.Effect<void>;
  readonly recordRecoveryBatch: (input: {
    readonly batch: ProviderTranscriptJournalBatch;
    readonly outcome: ReturnType<typeof outcomeFromExit>;
  }) => Effect.Effect<void>;
  readonly finishRecovery: Effect.Effect<void>;
  readonly reset: Effect.Effect<void>;
  readonly debugSnapshot: Effect.Effect<TranscriptJournalTrackerDebugSnapshot>;
}

export class TranscriptJournalTracker extends Context.Service<
  TranscriptJournalTracker,
  TranscriptJournalTrackerShape
>()("t3/observability/TranscriptJournalObservability/TranscriptJournalTracker") {}

function oldestEventLagMs(
  events: ReadonlyArray<{ readonly createdAt: string }>,
  nowMs: number,
): number {
  let oldestCreatedAtMs = Number.POSITIVE_INFINITY;
  for (const event of events) {
    const createdAtMs = Date.parse(event.createdAt);
    if (Number.isFinite(createdAtMs)) oldestCreatedAtMs = Math.min(oldestCreatedAtMs, createdAtMs);
  }
  return Number.isFinite(oldestCreatedAtMs) ? Math.max(0, nowMs - oldestCreatedAtMs) : 0;
}

export const makeTranscriptJournalTracker = Effect.gen(function* () {
  const lock = yield* Semaphore.make(1);
  const events = new Map<string, TrackedJournalEvent>();
  const oldestHeap: JournalHeapNode[] = [];
  let nextToken = 0;
  let hydrated = false;
  let workUnits = 0;
  let recoverySummary: RecoverySummary | null = null;
  let recoverySummaryLogs = 0;

  const less = (left: JournalHeapNode, right: JournalHeapNode) =>
    left.createdAtMs < right.createdAtMs ||
    (left.createdAtMs === right.createdAtMs && left.token < right.token);
  const heapPush = (node: JournalHeapNode) => {
    oldestHeap.push(node);
    let index = oldestHeap.length - 1;
    while (index > 0) {
      workUnits += 1;
      const parent = Math.floor((index - 1) / 2);
      if (!less(node, oldestHeap[parent]!)) break;
      oldestHeap[index] = oldestHeap[parent]!;
      index = parent;
    }
    oldestHeap[index] = node;
  };
  const heapPop = () => {
    workUnits += 1;
    const root = oldestHeap[0];
    const tail = oldestHeap.pop();
    if (root === undefined || tail === undefined || oldestHeap.length === 0) return root;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= oldestHeap.length) break;
      const right = left + 1;
      const child =
        right < oldestHeap.length && less(oldestHeap[right]!, oldestHeap[left]!) ? right : left;
      workUnits += 1;
      if (!less(oldestHeap[child]!, tail)) break;
      oldestHeap[index] = oldestHeap[child]!;
      index = child;
    }
    oldestHeap[index] = tail;
    return root;
  };
  const rebuildHeapIfSparse = () => {
    if (oldestHeap.length <= Math.max(1_024, events.size * 2 + 1)) return;
    oldestHeap.length = 0;
    for (const [identity, tracked] of events) {
      if (Number.isFinite(tracked.createdAtMs)) {
        oldestHeap.push({
          identity,
          createdAtMs: tracked.createdAtMs,
          token: tracked.token,
        });
      }
    }
    // Bottom-up heap construction is linear, keeping repeated add/remove churn
    // amortized and preventing stale lazy-deletion nodes from retaining memory.
    for (let index = Math.floor(oldestHeap.length / 2) - 1; index >= 0; index -= 1) {
      const node = oldestHeap[index]!;
      let parent = index;
      while (true) {
        const left = parent * 2 + 1;
        if (left >= oldestHeap.length) break;
        const right = left + 1;
        const child =
          right < oldestHeap.length && less(oldestHeap[right]!, oldestHeap[left]!) ? right : left;
        workUnits += 1;
        if (!less(oldestHeap[child]!, node)) break;
        oldestHeap[parent] = oldestHeap[child]!;
        parent = child;
      }
      oldestHeap[parent] = node;
    }
  };
  const pruneOldest = () => {
    while (oldestHeap.length > 0) {
      const candidate = oldestHeap[0]!;
      const current = events.get(candidate.identity);
      workUnits += 1;
      if (current?.token === candidate.token) return candidate.createdAtMs;
      heapPop();
    }
    return null;
  };
  const register = (event: ProviderTranscriptJournalEntry["event"]) => {
    const identity = journalEventIdentity(event);
    if (events.has(identity)) return false;
    const createdAtMs = Date.parse(event.createdAt);
    const token = ++nextToken;
    events.set(identity, { event, createdAtMs, token });
    workUnits += 1;
    if (Number.isFinite(createdAtMs)) heapPush({ identity, createdAtMs, token });
    return true;
  };
  const publishState = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    rebuildHeapIfSparse();
    const oldestCreatedAtMs = pruneOldest();
    const oldestLagMs = oldestCreatedAtMs === null ? 0 : Math.max(0, nowMs - oldestCreatedAtMs);
    yield* Metric.update(providerTranscriptJournalDepth, events.size);
    yield* Metric.update(providerTranscriptJournalOldestEventLag, oldestLagMs);
    setWorkloadGauge("ingestion.journal.undelivered", events.size);
    setWorkloadGauge("ingestion.journal.oldest_event_lag_ms", oldestLagMs);
  });
  const mutateAndPublish = (mutate: () => boolean) =>
    lock.withPermits(1)(
      Effect.sync(mutate).pipe(Effect.flatMap((changed) => (changed ? publishState : Effect.void))),
    );

  const tracker: TranscriptJournalTrackerShape = {
    hydrateOnce: (entries) =>
      mutateAndPublish(() => {
        if (hydrated) return false;
        hydrated = true;
        for (const entry of entries) register(entry.event);
        return true;
      }),
    registerAccepted: (event) => mutateAndPublish(() => register(event)),
    registerEntries: (entries) =>
      mutateAndPublish(() => {
        let changed = false;
        for (const entry of entries) changed = register(entry.event) || changed;
        return changed;
      }),
    removeSucceeded: (removedEvents) =>
      mutateAndPublish(() => {
        let changed = false;
        for (const event of removedEvents) {
          changed = events.delete(journalEventIdentity(event)) || changed;
          workUnits += 1;
        }
        return changed;
      }),
    beginRecovery: ({ batchCount, sourceEventCount }) =>
      lock.withPermits(1)(
        Clock.currentTimeNanos.pipe(
          Effect.tap((startedAtNanos) =>
            Effect.sync(() => {
              recoverySummary = {
                startedAtNanos,
                expectedBatches: batchCount,
                expectedSourceEvents: sourceEventCount,
                completedBatches: 0,
                failedBatches: 0,
                completedSourceEvents: 0,
                failedEventIds: [],
              };
            }),
          ),
          Effect.asVoid,
        ),
      ),
    recordRecoveryBatch: ({ batch, outcome }) =>
      // A synchronous mutation is atomic in the Effect runtime and avoids a
      // semaphore acquisition per recovered row on high-cardinality startup.
      Effect.sync(() => {
        if (recoverySummary === null) return;
        recoverySummary.completedBatches += 1;
        recoverySummary.completedSourceEvents += batch.sourceEvents.length;
        if (outcome === "success") return;
        recoverySummary.failedBatches += 1;
        if (recoverySummary.failedEventIds.length < 8) {
          recoverySummary.failedEventIds.push(String(batch.event.eventId));
        }
      }),
    finishRecovery: lock.withPermits(1)(
      Effect.gen(function* () {
        if (recoverySummary === null) return;
        const summary = recoverySummary;
        recoverySummary = null;
        recoverySummaryLogs += 1;
        const endedAtNanos = yield* Clock.currentTimeNanos;
        const durationMs = Duration.toMillis(
          Duration.nanos(
            endedAtNanos > summary.startedAtNanos ? endedAtNanos - summary.startedAtNanos : 0n,
          ),
        );
        const log = summary.failedBatches > 0 ? Effect.logWarning : Effect.logInfo;
        yield* log("provider transcript journal recovery completed", {
          expectedBatches: summary.expectedBatches,
          expectedSourceEvents: summary.expectedSourceEvents,
          completedBatches: summary.completedBatches,
          completedSourceEvents: summary.completedSourceEvents,
          failedBatches: summary.failedBatches,
          failedEventIds: summary.failedEventIds,
          durationMs,
        });
      }),
    ),
    reset: mutateAndPublish(() => {
      const changed = hydrated || events.size > 0 || oldestHeap.length > 0;
      hydrated = false;
      events.clear();
      oldestHeap.length = 0;
      recoverySummary = null;
      return changed;
    }),
    debugSnapshot: lock.withPermits(1)(
      Effect.sync(() => ({
        hydrated,
        depth: events.size,
        oldestCreatedAtMs: pruneOldest(),
        heapSize: oldestHeap.length,
        workUnits,
        recoverySummaryLogs,
      })),
    ),
  };
  return tracker;
});

export const TranscriptJournalTrackerLive = Layer.effect(
  TranscriptJournalTracker,
  makeTranscriptJournalTracker,
);

/** Provide one tracker instance to a consumer and expose that same instance. */
export function withTranscriptJournalTracker<ROut, E, RIn>(
  layer: Layer.Layer<ROut, E, RIn>,
): Layer.Layer<ROut | TranscriptJournalTracker, E, Exclude<RIn, TranscriptJournalTracker>> {
  return Layer.mergeAll(
    TranscriptJournalTrackerLive,
    layer.pipe(Layer.provide(TranscriptJournalTrackerLive)),
  ) as Layer.Layer<ROut | TranscriptJournalTracker, E, Exclude<RIn, TranscriptJournalTracker>>;
}

export const observeTranscriptJournalBatch = <A, E, R>(input: {
  readonly tracker: TranscriptJournalTrackerShape;
  readonly phase: TranscriptJournalIngestionPhase;
  readonly batch: ProviderTranscriptJournalBatch;
  readonly effect: Effect.Effect<A, E, R>;
}): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const startedAtNanos = yield* Clock.currentTimeNanos;
    const startedAtMs = yield* Clock.currentTimeMillis;
    const exit = yield* Effect.exit(input.effect);
    const endedAtNanos = yield* Clock.currentTimeNanos;
    const duration = Duration.nanos(
      endedAtNanos > startedAtNanos ? endedAtNanos - startedAtNanos : 0n,
    );
    const outcome = outcomeFromExit(exit);
    const batchKind = providerTranscriptJournalBatchKind(input.batch);
    const sourceEventCount = input.batch.sourceEvents.length;
    const characterCount = providerTranscriptJournalBatchCharacterCount(input.batch);
    const lagMs = oldestEventLagMs(input.batch.sourceEvents, startedAtMs);
    const attributes = metricAttributes({ phase: input.phase, batchKind, outcome });

    yield* Metric.update(
      Metric.withAttributes(providerTranscriptJournalBatchesTotal, attributes),
      1,
    );
    yield* Metric.update(
      Metric.withAttributes(providerTranscriptJournalSourceEventsTotal, attributes),
      sourceEventCount,
    );
    yield* Metric.update(
      Metric.withAttributes(providerTranscriptJournalBatchEvents, attributes),
      sourceEventCount,
    );
    yield* Metric.update(
      Metric.withAttributes(providerTranscriptJournalBatchCharacters, attributes),
      characterCount,
    );
    yield* Metric.update(
      Metric.withAttributes(providerTranscriptJournalBatchDuration, attributes),
      duration,
    );
    yield* Metric.update(
      Metric.withAttributes(providerTranscriptJournalIngestionLag, attributes),
      Duration.millis(lagMs),
    );

    incrementWorkloadCounter("ingestion.journal.batches");
    incrementWorkloadCounter("ingestion.journal.source_events", sourceEventCount);
    incrementWorkloadCounter("ingestion.journal.batch_characters", characterCount);
    incrementWorkloadCounter("ingestion.journal.lag_ms_total", lagMs);
    setWorkloadGauge("ingestion.journal.last_batch_events", sourceEventCount);
    if (outcome !== "success") incrementWorkloadCounter("ingestion.journal.failures");

    if (outcome === "success") {
      yield* input.tracker.removeSucceeded(input.batch.sourceEvents);
    }

    if (input.phase === "recovery") {
      yield* input.tracker.recordRecoveryBatch({ batch: input.batch, outcome });
    }

    const durationMs = Duration.toMillis(duration);
    if ((input.phase === "live" && outcome !== "success") || durationMs >= 250) {
      const log = outcome === "failure" ? Effect.logWarning : Effect.logInfo;
      yield* log("provider transcript journal batch completed", {
        phase: input.phase,
        batchKind,
        outcome,
        sourceEventCount,
        characterCount,
        durationMs,
        oldestEventLagMs: lagMs,
      });
    }

    if (Exit.isSuccess(exit)) return exit.value;
    return yield* Effect.failCause(exit.cause);
  });
