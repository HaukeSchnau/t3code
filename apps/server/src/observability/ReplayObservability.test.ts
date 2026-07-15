import { assert, describe, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Metric from "effect/Metric";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  readWorkloadDiagnosticsSnapshot,
  resetWorkloadDiagnosticsForTesting,
} from "../diagnostics/WorkloadDiagnostics.ts";
import { makeReplayLogPublisherLayer } from "./ReplayLogPublisher.ts";

import {
  makeReplayObserverWithRecorder,
  readReplayObservationReportsForTesting,
  replayCatchUpWithLive,
  replayEventBatch,
  resetReplayObservationReportsForTesting,
  type ReplayObservationReport,
} from "./ReplayObservability.ts";

class ReplayTestError extends Data.TaggedError("ReplayTestError")<{
  readonly message: string;
}> {}

const counterValue = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
): number =>
  Number(
    snapshots.find(
      (snapshot): snapshot is Extract<Metric.Metric.Snapshot, { readonly type: "Counter" }> =>
        snapshot.type === "Counter" &&
        snapshot.id === id &&
        Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
    )?.state.count ?? 0,
  );

describe("ReplayObservability", () => {
  it.effect("reports deterministic replay work, overlap, and live-buffer high-water", () =>
    Effect.gen(function* () {
      const reports: Array<ReplayObservationReport> = [];
      const observer = yield* makeReplayObserverWithRecorder("shell", 10, (report) =>
        Effect.sync(() => reports.push(report)),
      );

      observer.recordBatch([{ sequence: 11 }, { sequence: 12 }]);
      observer.recordBatch([{ sequence: 13 }]);
      observer.recordEmitted(11);
      observer.recordEmitted(13);
      observer.recordLiveBuffered(12);
      observer.recordLiveBuffered(14);
      observer.recordLiveBuffered(15);
      observer.recordLiveDequeued();
      observer.recordLiveBuffered(16);

      yield* TestClock.adjust(Duration.millis(2_500));
      yield* observer.finish(Exit.succeed(undefined));
      yield* observer.finish(Exit.succeed(undefined));

      assert.deepStrictEqual(reports, [
        {
          flow: "shell",
          outcome: "success",
          durationMs: 2_500,
          persistedTailSequence: 13,
          pages: 2,
          scannedEvents: 3,
          emittedEvents: 2,
          dedupedOverlapEvents: 1,
          liveBufferHighWaterMark: 3,
        },
      ]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("finalizes failed stream catch-up observations", () =>
    Effect.gen(function* () {
      const reports: Array<ReplayObservationReport> = [];
      const observer = yield* makeReplayObserverWithRecorder("thread", 20, (report) =>
        Effect.sync(() => reports.push(report)),
      );
      const stream = Stream.make({ sequence: 21 }).pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            observer.recordBatch([event]);
            observer.recordEmitted(event.sequence);
          }),
        ),
        Stream.concat(Stream.fail(new ReplayTestError({ message: "storage unavailable" }))),
        Stream.onExit(observer.finish),
      );

      const exit = yield* Stream.runCollect(stream).pipe(Effect.exit);

      assert.equal(Exit.isFailure(exit), true);
      assert.equal(reports.length, 1);
      assert.deepStrictEqual(reports[0], {
        flow: "thread",
        outcome: "failure",
        durationMs: 0,
        persistedTailSequence: 21,
        pages: 1,
        scannedEvents: 1,
        emittedEvents: 1,
        dedupedOverlapEvents: 0,
        liveBufferHighWaterMark: 0,
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("finalizes cancelled stream catch-up observations", () =>
    Effect.gen(function* () {
      const reports: Array<ReplayObservationReport> = [];
      const observer = yield* makeReplayObserverWithRecorder("rpc", 30, (report) =>
        Effect.sync(() => reports.push(report)),
      );
      const fiber = yield* Stream.runDrain(
        (Stream.never as Stream.Stream<never, never>).pipe(Stream.onExit(observer.finish)),
      ).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(75));
      yield* Fiber.interrupt(fiber);

      assert.equal(reports.length, 1);
      assert.deepStrictEqual(reports[0], {
        flow: "rpc",
        outcome: "interrupt",
        durationMs: 75,
        persistedTailSequence: 30,
        pages: 0,
        scannedEvents: 0,
        emittedEvents: 0,
        dedupedOverlapEvents: 0,
        liveBufferHighWaterMark: 0,
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("publishes production unary metrics, workload counters, and bounded logs", () =>
    Effect.gen(function* () {
      const reports: Array<ReplayObservationReport> = [];
      const reportsPublished = yield* Deferred.make<void>();
      const publisherLayer = makeReplayLogPublisherLayer({
        capacity: 2,
        write: (report) =>
          Effect.sync(() => {
            reports.push(report);
            return reports.length;
          }).pipe(
            Effect.flatMap((reportCount) =>
              reportCount === 2 ? Deferred.succeed(reportsPublished, undefined) : Effect.void,
            ),
          ),
      });
      resetWorkloadDiagnosticsForTesting();
      resetReplayObservationReportsForTesting();
      const metricsBefore = yield* Metric.snapshot;

      const [replayed, failed] = yield* Effect.gen(function* () {
        const replayed = yield* replayEventBatch({
          initialSequence: 40,
          events: Stream.make({ sequence: 41 }, { sequence: 42 }),
          transform: (events) => Effect.succeed(events),
        });
        const failed = yield* replayEventBatch({
          initialSequence: 42,
          events: Stream.make({ sequence: 43 }).pipe(
            Stream.concat(Stream.fail(new ReplayTestError({ message: "read failed" }))),
          ),
          transform: (events) => Effect.succeed(events),
        }).pipe(Effect.exit);
        yield* Deferred.await(reportsPublished);
        return [replayed, failed] as const;
      }).pipe(Effect.provide(publisherLayer));

      assert.deepStrictEqual(
        replayed.map((event) => event.sequence),
        [41, 42],
      );
      assert.equal(Exit.isFailure(failed), true);
      const workload = readWorkloadDiagnosticsSnapshot();
      assert.equal(workload.counters["replay.operations"], 2);
      assert.equal(workload.counters["replay.pages"], 2);
      assert.equal(workload.counters["replay.events_scanned"], 3);
      assert.equal(workload.counters["replay.events_emitted"], 2);
      assert.equal(workload.counters["replay.logs_dropped"], 0);
      assert.equal(readReplayObservationReportsForTesting().rpc?.outcome, "failure");

      const metricsAfter = yield* Metric.snapshot;
      assert.equal(
        counterValue(metricsAfter, "t3_replay_pages_total", { flow: "rpc" }) -
          counterValue(metricsBefore, "t3_replay_pages_total", { flow: "rpc" }),
        2,
      );
      assert.equal(
        counterValue(metricsAfter, "t3_replay_events_scanned_total", { flow: "rpc" }) -
          counterValue(metricsBefore, "t3_replay_events_scanned_total", { flow: "rpc" }),
        3,
      );
      assert.equal(
        counterValue(metricsAfter, "t3_replay_events_emitted_total", { flow: "rpc" }) -
          counterValue(metricsBefore, "t3_replay_events_emitted_total", { flow: "rpc" }),
        2,
      );
      assert.deepStrictEqual(
        reports.map(({ outcome, pages, scannedEvents, emittedEvents }) => ({
          outcome,
          pages,
          scannedEvents,
          emittedEvents,
        })),
        [
          { outcome: "success", pages: 1, scannedEvents: 2, emittedEvents: 2 },
          { outcome: "failure", pages: 1, scannedEvents: 1, emittedEvents: 0 },
        ],
      );
    }),
  );

  it.effect("keeps shell catch-up before a bounded live buffer and reports pre-filter work", () =>
    Effect.gen(function* () {
      const reports: Array<ReplayObservationReport> = [];
      const thirdLiveAttempted = yield* Deferred.make<void>();
      const observer = makeReplayObserverWithRecorder("shell", 0, (report) =>
        Effect.sync(() => reports.push(report)),
      );
      const live: Stream.Stream<number> = Stream.make(2, 4, 5).pipe(
        Stream.tap((sequence) =>
          sequence === 5 ? Deferred.succeed(thirdLiveAttempted, undefined) : Effect.void,
        ),
      );
      const stream = replayCatchUpWithLive({
        observer,
        live,
        sequence: (sequence) => sequence,
        bufferCapacity: 2,
        catchUp: (replayObserver) =>
          Stream.fromEffect(
            Deferred.await(thirdLiveAttempted).pipe(
              Effect.tap(() =>
                Effect.sync(() =>
                  replayObserver.recordBatch([
                    { sequence: 1 },
                    { sequence: 2 },
                    { sequence: 3 },
                    { sequence: 4 },
                  ]),
                ),
              ),
              Effect.as([1, 4] as const),
            ),
          ).pipe(Stream.flattenIterable),
      });

      const output = yield* stream.pipe(Stream.take(5), Stream.runCollect, Effect.scoped);

      assert.deepStrictEqual(Array.from(output), [1, 4, 2, 4, 5]);
      assert.equal(reports.length, 1);
      assert.deepStrictEqual(reports[0], {
        flow: "shell",
        outcome: "success",
        durationMs: 0,
        persistedTailSequence: 4,
        pages: 1,
        scannedEvents: 4,
        emittedEvents: 2,
        dedupedOverlapEvents: 2,
        liveBufferHighWaterMark: 2,
      });
    }),
  );

  it.effect("reports global scans separately from filtered thread catch-up", () =>
    Effect.gen(function* () {
      const reports: Array<ReplayObservationReport> = [];
      const thirdLiveAttempted = yield* Deferred.make<void>();
      const stream = replayCatchUpWithLive({
        observer: makeReplayObserverWithRecorder("thread", 10, (report) =>
          Effect.sync(() => reports.push(report)),
        ),
        live: (Stream.make(12, 14, 15) as Stream.Stream<number>).pipe(
          Stream.tap((sequence) =>
            sequence === 15 ? Deferred.succeed(thirdLiveAttempted, undefined) : Effect.void,
          ),
        ),
        sequence: (sequence) => sequence,
        bufferCapacity: 2,
        catchUp: (observer) =>
          Stream.fromEffect(
            Deferred.await(thirdLiveAttempted).pipe(
              Effect.tap(() =>
                Effect.sync(() =>
                  observer.recordBatch([{ sequence: 11 }, { sequence: 12 }, { sequence: 13 }]),
                ),
              ),
              Effect.as(13),
            ),
          ),
      });

      const output = yield* stream.pipe(Stream.take(4), Stream.runCollect, Effect.scoped);

      assert.deepStrictEqual(Array.from(output), [13, 12, 14, 15]);
      assert.equal(reports.length, 1);
      assert.deepStrictEqual(reports[0], {
        flow: "thread",
        outcome: "success",
        durationMs: 0,
        persistedTailSequence: 13,
        pages: 1,
        scannedEvents: 3,
        emittedEvents: 1,
        dedupedOverlapEvents: 1,
        liveBufferHighWaterMark: 2,
      });
    }),
  );

  it.effect("finalizes setup defects exactly once through the replay scope", () =>
    Effect.gen(function* () {
      const reports: Array<ReplayObservationReport> = [];
      const stream = replayCatchUpWithLive({
        observer: makeReplayObserverWithRecorder("shell", 50, (report) =>
          Effect.sync(() => reports.push(report)),
        ),
        live: Stream.empty as Stream.Stream<number, never, never>,
        sequence: (sequence: number) => sequence,
        bufferCapacity: 1,
        catchUp: (): Stream.Stream<number, never, never> => {
          throw new Error("catch-up construction failed");
        },
      });

      const exit = yield* stream.pipe(Stream.runDrain, Effect.scoped, Effect.exit);

      assert.equal(Exit.isFailure(exit), true);
      assert.equal(reports.length, 1);
      assert.equal(reports[0]?.outcome, "failure");
    }),
  );

  it.effect("finalizes actual catch-up cancellation exactly once", () =>
    Effect.gen(function* () {
      const reports: Array<ReplayObservationReport> = [];
      const stream = replayCatchUpWithLive({
        observer: makeReplayObserverWithRecorder("thread", 60, (report) =>
          Effect.sync(() => reports.push(report)),
        ),
        live: Stream.empty as Stream.Stream<number, never, never>,
        sequence: (sequence: number) => sequence,
        bufferCapacity: 1,
        catchUp: () => Stream.never as Stream.Stream<number, never, never>,
      });
      const fiber = yield* stream.pipe(Stream.runDrain, Effect.scoped, Effect.forkChild);

      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);

      assert.equal(reports.length, 1);
      assert.equal(reports[0]?.outcome, "interrupt");
    }),
  );
});
