import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";

import { recordRuntimeMetrics } from "./RuntimeMetrics.ts";

const gaugeValue = (snapshots: ReadonlyArray<Metric.Metric.Snapshot>, id: string) => {
  const snapshot = snapshots.find((candidate) => candidate.id === id);
  return snapshot?.type === "Gauge" ? snapshot.state.value : undefined;
};

it.effect("records event-loop delay and SQLite file sizes", () =>
  Effect.gen(function* () {
    const directory = mkdtempSync(join(tmpdir(), "t3-runtime-metrics-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
    );
    const dbPath = join(directory, "state.sqlite");
    writeFileSync(dbPath, "database");
    writeFileSync(`${dbPath}-wal`, "wal");

    yield* recordRuntimeMetrics({ dbPath, eventLoopDelayNanoseconds: 2_500_000 });

    const snapshots = yield* Metric.snapshot;
    assert.equal(gaugeValue(snapshots, "t3_event_loop_delay_milliseconds"), 2.5);
    assert.equal(gaugeValue(snapshots, "t3_sqlite_database_size_bytes"), 8);
    assert.equal(gaugeValue(snapshots, "t3_sqlite_wal_size_bytes"), 3);

    yield* recordRuntimeMetrics({ dbPath, eventLoopDelayNanoseconds: Number.NaN });
    const normalizedSnapshots = yield* Metric.snapshot;
    assert.equal(gaugeValue(normalizedSnapshots, "t3_event_loop_delay_milliseconds"), 0);

    rmSync(`${dbPath}-wal`);
    yield* recordRuntimeMetrics({ dbPath, eventLoopDelayNanoseconds: 1 });
    const missingWalSnapshots = yield* Metric.snapshot;
    assert.equal(gaugeValue(missingWalSnapshots, "t3_sqlite_wal_size_bytes"), 0);

    yield* recordRuntimeMetrics({
      dbPath: join(directory, "missing.sqlite"),
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
  }),
);
