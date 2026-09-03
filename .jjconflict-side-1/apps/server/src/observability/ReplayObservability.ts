import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Metric from "effect/Metric";
import * as Queue from "effect/Queue";
import * as Pull from "effect/Pull";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as Take from "effect/Take";

import {
  incrementWorkloadCounter,
  setWorkloadGauge,
  type WorkloadGaugeName,
} from "../diagnostics/WorkloadDiagnostics.ts";
import { outcomeFromExit, type ObservabilityOutcome } from "./Attributes.ts";
import {
  metricAttributes,
  replayDuration,
  replayEventsEmittedTotal,
  replayEventsScannedTotal,
  replayLiveBufferHighWater,
  replayOperationsTotal,
  replayOverlapEventsTotal,
  replayPagesTotal,
  replayProbeBytesTotal,
  replayProbeEventsTotal,
  replayStrategiesTotal,
} from "./Metrics.ts";
import { ReplayLogPublisher } from "./ReplayLogPublisher.ts";

export type ReplayFlow = "rpc" | "shell" | "thread";

export interface ReplayStrategyObservation {
  readonly strategy: "snapshot" | "events";
  readonly reason:
    | "bounded"
    | "event-count"
    | "payload-bytes"
    | "capability-unavailable"
    | "probe-failed"
    | "snapshot-unavailable"
    | "snapshot-stale"
    | "snapshot-failed";
  readonly probeEventCount: number;
  readonly probePayloadBytes: number;
  readonly snapshotSequence?: number;
}

export interface ReplayObservationReport {
  readonly flow: ReplayFlow;
  readonly outcome: ObservabilityOutcome;
  readonly durationMs: number;
  readonly persistedTailSequence: number;
  readonly pages: number;
  readonly scannedEvents: number;
  readonly emittedEvents: number;
  readonly dedupedOverlapEvents: number;
  readonly liveBufferHighWaterMark: number;
  readonly strategy?: ReplayStrategyObservation;
}

const latestReplayReports: Partial<Record<ReplayFlow, ReplayObservationReport>> = {};

const replayLastDurationGauge = {
  rpc: "replay.rpc.last_duration_ms",
  shell: "replay.shell.last_duration_ms",
  thread: "replay.thread.last_duration_ms",
} as const satisfies Record<ReplayFlow, WorkloadGaugeName>;

const nonNegativeInt = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

export function readReplayObservationReportsForTesting(): Readonly<
  Partial<Record<ReplayFlow, ReplayObservationReport>>
> {
  return { ...latestReplayReports };
}

export function resetReplayObservationReportsForTesting(): void {
  for (const flow of ["rpc", "shell", "thread"] as const) delete latestReplayReports[flow];
}

export interface ReplayObserver {
  readonly recordPage: () => void;
  readonly recordScanned: (sequence: number) => void;
  readonly recordBatch: (events: ReadonlyArray<{ readonly sequence: number }>) => void;
  readonly recordEmitted: (sequence: number) => void;
  readonly recordLiveBuffered: (sequence: number) => void;
  readonly recordLiveDequeued: () => void;
  /** Records only observer-local state; metrics and logs are updated during `finish`. */
  readonly recordStrategy: (strategy: ReplayStrategyObservation) => void;
  readonly finish: <A, E>(exit: Exit.Exit<A, E>) => Effect.Effect<void>;
}

export type ReplayReportRecorder = (report: ReplayObservationReport) => Effect.Effect<void>;

const recordReplayReport =
  (replayLogPublisher: ReplayLogPublisher["Service"]): ReplayReportRecorder =>
  (report) =>
    Effect.gen(function* () {
      const attributes = metricAttributes({
        flow: report.flow,
        outcome: report.outcome,
      });
      const flowAttributes = metricAttributes({ flow: report.flow });

      yield* Metric.update(Metric.withAttributes(replayOperationsTotal, attributes), 1);
      yield* Metric.update(
        Metric.withAttributes(replayDuration, attributes),
        Duration.millis(report.durationMs),
      );
      yield* Metric.update(Metric.withAttributes(replayPagesTotal, flowAttributes), report.pages);
      yield* Metric.update(
        Metric.withAttributes(replayEventsScannedTotal, flowAttributes),
        report.scannedEvents,
      );
      yield* Metric.update(
        Metric.withAttributes(replayEventsEmittedTotal, flowAttributes),
        report.emittedEvents,
      );
      yield* Metric.update(
        Metric.withAttributes(replayOverlapEventsTotal, flowAttributes),
        report.dedupedOverlapEvents,
      );
      yield* Metric.update(
        Metric.withAttributes(replayLiveBufferHighWater, flowAttributes),
        report.liveBufferHighWaterMark,
      );
      if (report.strategy !== undefined) {
        const strategyAttributes = metricAttributes({
          flow: report.flow,
          strategy: report.strategy.strategy,
          reason: report.strategy.reason,
          outcome: report.outcome,
        });
        yield* Metric.update(Metric.withAttributes(replayStrategiesTotal, strategyAttributes), 1);
        yield* Metric.update(
          Metric.withAttributes(replayProbeEventsTotal, strategyAttributes),
          report.strategy.probeEventCount,
        );
        yield* Metric.update(
          Metric.withAttributes(replayProbeBytesTotal, strategyAttributes),
          report.strategy.probePayloadBytes,
        );
      }

      incrementWorkloadCounter("replay.operations");
      incrementWorkloadCounter("replay.pages", report.pages);
      incrementWorkloadCounter("replay.events_scanned", report.scannedEvents);
      incrementWorkloadCounter("replay.events_emitted", report.emittedEvents);
      incrementWorkloadCounter("replay.overlap_deduped", report.dedupedOverlapEvents);
      incrementWorkloadCounter("replay.duration_ms", report.durationMs);
      setWorkloadGauge(replayLastDurationGauge[report.flow], report.durationMs);
      if (report.strategy !== undefined) {
        incrementWorkloadCounter(`replay.strategy.${report.strategy.strategy}`);
        incrementWorkloadCounter("replay.probe_events", report.strategy.probeEventCount);
        incrementWorkloadCounter("replay.probe_bytes", report.strategy.probePayloadBytes);
      }
      latestReplayReports[report.flow] = report;

      yield* replayLogPublisher.publish(report);
    });

const makeReplayObserverWith = Effect.fn("ReplayObservability.makeReplayObserverWith")(function* (
  flow: ReplayFlow,
  initialSequence: number,
  recorder: ReplayReportRecorder,
) {
  const startedAt = yield* Clock.currentTimeNanos;
  let persistedTailSequence = initialSequence;
  let pages = 0;
  let scannedEvents = 0;
  let emittedEvents = 0;
  let liveBuffered = 0;
  let liveBufferHighWaterMark = 0;
  let finished = false;
  let strategy: ReplayStrategyObservation | undefined;
  const bufferedLiveSequences = new Map<number, number>();

  return {
    recordPage() {
      if (finished) return;
      pages += 1;
    },
    recordScanned(sequence) {
      if (finished) return;
      scannedEvents += 1;
      persistedTailSequence = Math.max(persistedTailSequence, sequence);
    },
    recordBatch(events) {
      if (finished) return;
      pages += 1;
      scannedEvents += events.length;
      for (const event of events) {
        persistedTailSequence = Math.max(persistedTailSequence, event.sequence);
      }
    },
    recordEmitted(sequence) {
      if (finished) return;
      emittedEvents += 1;
      persistedTailSequence = Math.max(persistedTailSequence, sequence);
    },
    recordLiveBuffered(sequence) {
      if (finished) return;
      liveBuffered += 1;
      liveBufferHighWaterMark = Math.max(liveBufferHighWaterMark, liveBuffered);
      bufferedLiveSequences.set(sequence, (bufferedLiveSequences.get(sequence) ?? 0) + 1);
    },
    recordLiveDequeued() {
      if (finished) return;
      liveBuffered = Math.max(0, liveBuffered - 1);
    },
    recordStrategy(observation) {
      if (finished || strategy !== undefined) return;
      strategy = {
        ...observation,
        probeEventCount: nonNegativeInt(observation.probeEventCount),
        probePayloadBytes: nonNegativeInt(observation.probePayloadBytes),
      };
    },
    finish(exit) {
      if (finished) return Effect.void;
      finished = true;
      return Effect.gen(function* () {
        const endedAt = yield* Clock.currentTimeNanos;
        const elapsedNanos = endedAt > startedAt ? endedAt - startedAt : 0n;
        let dedupedOverlapEvents = 0;
        for (const [sequence, count] of bufferedLiveSequences) {
          if (sequence <= persistedTailSequence) dedupedOverlapEvents += count;
        }
        yield* recorder({
          flow,
          outcome: outcomeFromExit(exit),
          durationMs: Number(elapsedNanos) / 1_000_000,
          persistedTailSequence,
          pages,
          scannedEvents,
          emittedEvents,
          dedupedOverlapEvents,
          liveBufferHighWaterMark,
          ...(strategy === undefined ? {} : { strategy }),
        });
      });
    },
  } satisfies ReplayObserver;
});

export const makeReplayObserverWithRecorder = (
  flow: ReplayFlow,
  initialSequence: number,
  recorder: ReplayReportRecorder,
) => makeReplayObserverWith(flow, initialSequence, recorder);

export const makeReplayObserver = Effect.fn("ReplayObservability.makeReplayObserver")(function* (
  flow: ReplayFlow,
  initialSequence: number,
) {
  const replayLogPublisher = yield* ReplayLogPublisher;
  return yield* makeReplayObserverWith(
    flow,
    initialSequence,
    recordReplayReport(replayLogPublisher),
  );
});

export const observeReplayEffect = <A, E, R>(
  flow: ReplayFlow,
  initialSequence: number,
  use: (observer: ReplayObserver) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | ReplayLogPublisher> =>
  Effect.gen(function* () {
    const observer = yield* makeReplayObserver(flow, initialSequence);
    return yield* use(observer).pipe(Effect.onExit(observer.finish));
  });

export const replayEventBatch = <
  Event extends { readonly sequence: number },
  Output extends { readonly sequence: number },
  ReadError,
  ReadContext,
  TransformError,
  TransformContext,
>(options: {
  readonly initialSequence: number;
  readonly events: Stream.Stream<Event, ReadError, ReadContext>;
  readonly transform: (
    events: ReadonlyArray<Event>,
  ) => Effect.Effect<ReadonlyArray<Output>, TransformError, TransformContext>;
}): Effect.Effect<
  ReadonlyArray<Output>,
  ReadError | TransformError,
  ReadContext | TransformContext | ReplayLogPublisher
> =>
  observeReplayEffect("rpc", options.initialSequence, (observer) => {
    observer.recordPage();
    return options.events.pipe(
      Stream.tap((event) => Effect.sync(() => observer.recordScanned(event.sequence))),
      Stream.runCollect,
      Effect.map((events) => Array.from(events)),
      Effect.flatMap(options.transform),
      Effect.tap((events) =>
        Effect.sync(() => {
          for (const event of events) observer.recordEmitted(event.sequence);
        }),
      ),
    );
  });

export interface ReplayCatchUpOptions<
  A,
  Synchronized,
  CatchUpError,
  CatchUpContext,
  LiveError,
  LiveContext,
  ObserverContext,
> {
  readonly observer: Effect.Effect<ReplayObserver, never, ObserverContext>;
  readonly catchUp: (observer: ReplayObserver) => Stream.Stream<A, CatchUpError, CatchUpContext>;
  /** The caller must acquire the live source subscription before invoking this helper. */
  readonly live: Stream.Stream<A, LiveError, LiveContext>;
  readonly sequence: (item: A) => number;
  readonly bufferCapacity: number;
  /** Emitted exactly once after persisted catch-up and before buffered live items. */
  readonly synchronized?: () => Synchronized;
}

/**
 * Acquires the live stream's pull in the parent scope before reading history,
 * closing the otherwise unavoidable fork-before-subscribe loss window. The
 * queue also carries producer termination so live failure and normal
 * completion cannot leave consumers blocked forever.
 */
export const replayCatchUpWithLive = <
  A,
  Synchronized,
  CatchUpError,
  CatchUpContext,
  LiveError,
  LiveContext,
  ObserverContext,
>(
  options: ReplayCatchUpOptions<
    A,
    Synchronized,
    CatchUpError,
    CatchUpContext,
    LiveError,
    LiveContext,
    ObserverContext
  >,
): Stream.Stream<
  A | Synchronized,
  CatchUpError | LiveError,
  CatchUpContext | LiveContext | ObserverContext | Scope.Scope
> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const observer = yield* options.observer;
      yield* Effect.addFinalizer(observer.finish);
      const liveBuffer = yield* Queue.bounded<Take.Take<A, LiveError>>(options.bufferCapacity);
      const livePull = yield* Stream.toPull(options.live);
      const pumpLive: Effect.Effect<void> = Effect.suspend(() =>
        Pull.matchEffect(livePull, {
          onSuccess: (items) =>
            Effect.forEach(
              items,
              (item) =>
                Queue.offer(liveBuffer, [item]).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => observer.recordLiveBuffered(options.sequence(item))),
                  ),
                ),
              { concurrency: 1, discard: true },
            ).pipe(Effect.andThen(pumpLive)),
          onFailure: (cause) => Queue.offer(liveBuffer, Exit.failCause(cause)).pipe(Effect.asVoid),
          onDone: () => Queue.offer(liveBuffer, Exit.void).pipe(Effect.asVoid),
        }),
      );
      yield* Effect.forkScoped(pumpLive);
      const catchUpStream = options.catchUp(observer).pipe(
        Stream.tap((item) => Effect.sync(() => observer.recordEmitted(options.sequence(item)))),
        Stream.onExit(observer.finish),
      );
      const bufferedLiveStream = Stream.fromQueue(liveBuffer).pipe(
        Stream.tap((take) =>
          Array.isArray(take) ? Effect.sync(observer.recordLiveDequeued) : Effect.void,
        ),
        Stream.flattenTake,
      );
      const synchronizedStream =
        options.synchronized === undefined
          ? Stream.empty
          : Stream.fromEffect(Effect.sync(options.synchronized));
      return Stream.concat(Stream.concat(catchUpStream, synchronizedStream), bufferedLiveStream);
    }),
  );
