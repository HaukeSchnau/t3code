import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import {
  readWorkloadDiagnosticsSnapshot,
  resetWorkloadDiagnosticsForTesting,
} from "../diagnostics/WorkloadDiagnostics.ts";
import type { ReplayObservationReport } from "./ReplayObservability.ts";
import { makeReplayLogPublisherLayer, ReplayLogPublisher } from "./ReplayLogPublisher.ts";

const report = (persistedTailSequence: number): ReplayObservationReport => ({
  flow: "shell",
  outcome: "success",
  durationMs: 1,
  persistedTailSequence,
  pages: 1,
  scannedEvents: 1,
  emittedEvents: 1,
  dedupedOverlapEvents: 0,
  liveBufferHighWaterMark: 0,
});

describe("ReplayLogPublisher", () => {
  it.effect("uses one supervised dropping queue without blocking publishers", () =>
    Effect.gen(function* () {
      resetWorkloadDiagnosticsForTesting();
      const writerStarted = yield* Deferred.make<void>();
      const releaseWriter = yield* Deferred.make<void>();
      const secondWritten = yield* Deferred.make<void>();
      const written: Array<number> = [];
      const layer = makeReplayLogPublisherLayer({
        capacity: 1,
        write: (item) =>
          Deferred.succeed(writerStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseWriter)),
            Effect.andThen(
              Effect.sync(() => {
                written.push(item.persistedTailSequence);
                return written.length;
              }),
            ),
            Effect.tap((writtenCount) =>
              writtenCount === 2 ? Deferred.succeed(secondWritten, undefined) : Effect.void,
            ),
            Effect.asVoid,
          ),
      });

      const accepted = yield* Effect.gen(function* () {
        const publisher = yield* ReplayLogPublisher;
        const first = yield* publisher.publish(report(1));
        yield* Deferred.await(writerStarted);
        const second = yield* publisher.publish(report(2));
        const third = yield* publisher.publish(report(3));
        yield* Deferred.succeed(releaseWriter, undefined);
        yield* Deferred.await(secondWritten);
        return [first, second, third] as const;
      }).pipe(Effect.provide(layer));

      assert.deepStrictEqual(accepted, [true, true, false]);
      assert.deepStrictEqual(written, [1, 2]);
      assert.equal(readWorkloadDiagnosticsSnapshot().counters["replay.logs_dropped"], 1);
    }),
  );
});
