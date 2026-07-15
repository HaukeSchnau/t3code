import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Metric from "effect/Metric";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { incrementWorkloadCounter } from "../diagnostics/WorkloadDiagnostics.ts";
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
} from "./Metrics.ts";
import { ReplayLogPublisher } from "./ReplayLogPublisher.ts";

export type ReplayFlow = "rpc" | "shell" | "thread";

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
}

const latestReplayReports: Partial<Record<ReplayFlow, ReplayObservationReport>> = {};

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

      incrementWorkloadCounter("replay.operations");
      incrementWorkloadCounter("replay.pages", report.pages);
      incrementWorkloadCounter("replay.events_scanned", report.scannedEvents);
      incrementWorkloadCounter("replay.events_emitted", report.emittedEvents);
      incrementWorkloadCounter("replay.overlap_deduped", report.dedupedOverlapEvents);
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
  readonly live: Stream.Stream<A, LiveError, LiveContext>;
  readonly sequence: (item: A) => number;
  readonly bufferCapacity: number;
  /** Emitted exactly once after persisted catch-up and before buffered live items. */
  readonly synchronized?: () => Synchronized;
}

/**
 * Captures live events before reading history, then hands off without awaiting
 * any external diagnostics sink. The bounded queue and catch-up-first concat
 * intentionally preserve the existing replay ordering and backpressure.
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
  CatchUpError,
  CatchUpContext | LiveContext | ObserverContext | Scope.Scope
> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const observer = yield* options.observer;
      yield* Effect.addFinalizer(observer.finish);
      const liveBuffer = yield* Queue.bounded<A>(options.bufferCapacity);
      yield* Effect.forkScoped(
        options.live.pipe(
          Stream.runForEach((item) =>
            Queue.offer(liveBuffer, item).pipe(
              Effect.tap(() =>
                Effect.sync(() => observer.recordLiveBuffered(options.sequence(item))),
              ),
            ),
          ),
        ),
      );
      const catchUpStream = options.catchUp(observer).pipe(
        Stream.tap((item) => Effect.sync(() => observer.recordEmitted(options.sequence(item)))),
        Stream.onExit(observer.finish),
      );
      const bufferedLiveStream = Stream.fromQueue(liveBuffer).pipe(
        Stream.tap(() => Effect.sync(observer.recordLiveDequeued)),
      );
      const synchronizedStream =
        options.synchronized === undefined
          ? Stream.empty
          : Stream.fromEffect(Effect.sync(options.synchronized));
      return Stream.concat(Stream.concat(catchUpStream, synchronizedStream), bufferedLiveStream);
    }),
  );
