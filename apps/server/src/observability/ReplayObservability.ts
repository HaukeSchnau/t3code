import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Metric from "effect/Metric";

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

export interface ReplayObserver {
  readonly recordPage: () => void;
  readonly recordScanned: (sequence: number) => void;
  readonly recordBatch: (events: ReadonlyArray<{ readonly sequence: number }>) => void;
  readonly recordEmitted: (sequence: number) => void;
  readonly recordLiveBuffered: (sequence: number) => void;
  readonly recordLiveDequeued: () => void;
  readonly finish: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void>;
}

type ReplayReportRecorder = (report: ReplayObservationReport) => Effect.Effect<void>;

const recordReplayReport: ReplayReportRecorder = (report) =>
  Effect.gen(function* () {
    const attributes = metricAttributes({ flow: report.flow, outcome: report.outcome });
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

    yield* Effect.logInfo("orchestration replay completed", report);
  });

export const makeReplayObserver = Effect.fn("ReplayObservability.makeReplayObserver")(function* (
  flow: ReplayFlow,
  initialSequence: number,
  recorder: ReplayReportRecorder = recordReplayReport,
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

export const observeReplayEffect = <A, E, R>(
  flow: ReplayFlow,
  initialSequence: number,
  use: (observer: ReplayObserver) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const observer = yield* makeReplayObserver(flow, initialSequence);
    return yield* use(observer).pipe(Effect.onExit(observer.finish));
  });
