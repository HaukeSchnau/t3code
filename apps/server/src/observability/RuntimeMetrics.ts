import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";

import {
  runtimeMetricsCollectionErrors,
  sqliteDatabaseSizeBytes,
  sqliteWalSizeBytes,
} from "./Metrics.ts";

const isMissingFile = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound";

const fileSize = Effect.fn("RuntimeMetrics.fileSize")(function* (
  path: string,
  options: { readonly missingIsZero: boolean },
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.stat(path).pipe(
    Effect.map((file) => Number(file.size)),
    Effect.catch((error) =>
      options.missingIsZero && isMissingFile(error)
        ? Effect.succeed(0)
        : Metric.update(runtimeMetricsCollectionErrors, 1).pipe(Effect.as(undefined)),
    ),
  );
});

export const recordRuntimeMetrics = Effect.fn("RuntimeMetrics.recordRuntimeMetrics")(function* (
  dbPath: string,
) {
  const [databaseSize, walSize] = yield* Effect.all(
    [
      fileSize(dbPath, { missingIsZero: false }),
      fileSize(`${dbPath}-wal`, { missingIsZero: true }),
    ],
    { concurrency: "unbounded" },
  );
  if (databaseSize !== undefined) {
    yield* Metric.update(sqliteDatabaseSizeBytes, databaseSize);
  }
  if (walSize !== undefined) {
    yield* Metric.update(sqliteWalSizeBytes, walSize);
  }
});

export const layer = (dbPath: string) =>
  Layer.effectDiscard(
    recordRuntimeMetrics(dbPath).pipe(
      Effect.repeat(Schedule.spaced("30 seconds")),
      Effect.forkScoped,
    ),
  );
