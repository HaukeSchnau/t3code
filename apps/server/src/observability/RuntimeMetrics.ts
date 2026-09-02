import { stat } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Schedule from "effect/Schedule";

import {
  eventLoopDelayMilliseconds,
  runtimeMetricsCollectionErrors,
  sqliteDatabaseSizeBytes,
  sqliteWalSizeBytes,
} from "./Metrics.ts";

const isMissingFile = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const fileSize = Effect.fn("RuntimeMetrics.fileSize")(function* (
  path: string,
  options: { readonly missingIsZero: boolean },
) {
  return yield* Effect.tryPromise({
    try: () => stat(path),
    catch: (error) => error,
  }).pipe(
    Effect.map((file) => file.size),
    Effect.catch((error) =>
      options.missingIsZero && isMissingFile(error)
        ? Effect.succeed(0)
        : Metric.update(runtimeMetricsCollectionErrors, 1).pipe(Effect.as(undefined)),
    ),
  );
});

export const recordRuntimeMetrics = Effect.fn("RuntimeMetrics.recordRuntimeMetrics")(
  function* (input: { readonly dbPath: string; readonly eventLoopDelayNanoseconds: number }) {
    const [databaseSize, walSize] = yield* Effect.all(
      [
        fileSize(input.dbPath, { missingIsZero: false }),
        fileSize(`${input.dbPath}-wal`, { missingIsZero: true }),
      ],
      { concurrency: "unbounded" },
    );

    yield* Metric.update(
      eventLoopDelayMilliseconds,
      Number.isFinite(input.eventLoopDelayNanoseconds)
        ? input.eventLoopDelayNanoseconds / 1_000_000
        : 0,
    );
    if (databaseSize !== undefined) {
      yield* Metric.update(sqliteDatabaseSizeBytes, databaseSize);
    }
    if (walSize !== undefined) {
      yield* Metric.update(sqliteWalSizeBytes, walSize);
    }
  },
);

export const layer = (dbPath: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
      eventLoopDelay.enable();
      yield* Effect.addFinalizer(() => Effect.sync(() => eventLoopDelay.disable()));

      const sample = Effect.suspend(() =>
        recordRuntimeMetrics({
          dbPath,
          eventLoopDelayNanoseconds: eventLoopDelay.mean,
        }),
      ).pipe(Effect.tap(() => Effect.sync(() => eventLoopDelay.reset())));

      yield* sample.pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkScoped);
    }),
  );
