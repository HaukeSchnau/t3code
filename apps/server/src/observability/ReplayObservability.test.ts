import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { makeReplayObserver, type ReplayObservationReport } from "./ReplayObservability.ts";

describe("ReplayObservability", () => {
  it.effect("reports deterministic replay work, overlap, and live-buffer high-water", () =>
    Effect.gen(function* () {
      const reports: Array<ReplayObservationReport> = [];
      const observer = yield* makeReplayObserver("shell", 10, (report) =>
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
      const observer = yield* makeReplayObserver("thread", 20, (report) =>
        Effect.sync(() => reports.push(report)),
      );
      const stream = Stream.make({ sequence: 21 }).pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            observer.recordBatch([event]);
            observer.recordEmitted(event.sequence);
          }),
        ),
        Stream.concat(Stream.fail("storage unavailable")),
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
      const observer = yield* makeReplayObserver("rpc", 30, (report) =>
        Effect.sync(() => reports.push(report)),
      );
      const fiber = yield* Stream.runDrain(Stream.never.pipe(Stream.onExit(observer.finish))).pipe(
        Effect.forkChild,
      );

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
});
