import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Metric from "effect/Metric";
import * as Path from "effect/Path";

import { recordRuntimeMetrics } from "./RuntimeMetrics.ts";

const gaugeValue = (snapshots: ReadonlyArray<Metric.Metric.Snapshot>, id: string) => {
  const snapshot = snapshots.find((candidate) => candidate.id === id);
  return snapshot?.type === "Gauge" ? snapshot.state.value : undefined;
};

it.effect("records event-loop delay and SQLite file sizes", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-runtime-metrics-",
    });
    const dbPath = path.join(directory, "state.sqlite");
    yield* fileSystem.writeFileString(dbPath, "database");
    yield* fileSystem.writeFileString(`${dbPath}-wal`, "wal");

    yield* recordRuntimeMetrics({ dbPath, eventLoopDelayNanoseconds: 2_500_000 });

    const snapshots = yield* Metric.snapshot;
    assert.equal(gaugeValue(snapshots, "t3_event_loop_delay_milliseconds"), 2.5);
    assert.equal(gaugeValue(snapshots, "t3_sqlite_database_size_bytes"), 8);
    assert.equal(gaugeValue(snapshots, "t3_sqlite_wal_size_bytes"), 3);

    yield* recordRuntimeMetrics({ dbPath, eventLoopDelayNanoseconds: Number.NaN });
    const normalizedSnapshots = yield* Metric.snapshot;
    assert.equal(gaugeValue(normalizedSnapshots, "t3_event_loop_delay_milliseconds"), 0);

    yield* fileSystem.remove(`${dbPath}-wal`);
    yield* recordRuntimeMetrics({ dbPath, eventLoopDelayNanoseconds: 1 });
    const missingWalSnapshots = yield* Metric.snapshot;
    assert.equal(gaugeValue(missingWalSnapshots, "t3_sqlite_wal_size_bytes"), 0);

    yield* recordRuntimeMetrics({
      dbPath: path.join(directory, "missing.sqlite"),
      eventLoopDelayNanoseconds: 1,
    });
    const missingDatabaseSnapshots = yield* Metric.snapshot;
    const errors = missingDatabaseSnapshots.find(
      (candidate) => candidate.id === "t3_runtime_metrics_collection_errors_total",
    );
    assert.equal(errors?.type, "Counter");
    if (errors?.type === "Counter") {
      assert.equal(errors.state.count, 1);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
