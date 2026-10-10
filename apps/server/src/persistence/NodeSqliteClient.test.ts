// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "./NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("NodeSqliteClient", (it) => {
  it.effect("retries preparing a query after the missing schema becomes available", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const select = sql<{ name: string }>`SELECT name FROM created_after_prepare_failure`;
      const error = yield* select.pipe(Effect.flip);
      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");

      yield* sql`CREATE TABLE created_after_prepare_failure(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO created_after_prepare_failure VALUES ('recovered')`;
      assert.deepEqual(yield* select, [{ name: "recovered" }]);
      assert.deepEqual(yield* select.values, [["recovered"]]);
    }),
  );

  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");

      const unpreparedValues = yield* sql`SELECT id, name FROM entries ORDER BY id`
        .valuesUnprepared;
      assert.deepEqual(unpreparedValues, values);
    }),
  );

  it.effect("returns a typed failure when an unprepared statement cannot be prepared", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const error = yield* Effect.flip(sql.unsafe("SELECT FROM").unprepared);

      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");
    }),
  );

  it.effect("records the full SQLite transaction duration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql.withTransaction(sql`SELECT 1`);

      const snapshots = yield* Metric.snapshot;
      const transactionDuration = snapshots.find(
        (snapshot) =>
          snapshot.type === "Histogram" && snapshot.id === "t3_sqlite_transaction_duration",
      );

      assert.equal(transactionDuration?.type, "Histogram");
      if (transactionDuration?.type === "Histogram") {
        assert.equal(transactionDuration.state.count, 1);
      }
    }),
  );

  it.effect("records every SQLite statement execution", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const before = yield* Metric.snapshot;
      const beforeMetric = before.find(
        (snapshot) => snapshot.type === "Histogram" && snapshot.id === "t3_sql_execute_duration",
      );
      const beforeCount = beforeMetric?.type === "Histogram" ? beforeMetric.state.count : 0;

      yield* sql`SELECT 1`;
      yield* sql`SELECT 1`.raw;
      yield* sql`SELECT 1`.values;
      yield* sql`SELECT 1`.valuesUnprepared;
      yield* sql`SELECT 1`.unprepared;
      yield* Effect.exit(sql.unsafe("SELECT FROM").unprepared);

      const after = yield* Metric.snapshot;
      const executeDuration = after.find(
        (snapshot) => snapshot.type === "Histogram" && snapshot.id === "t3_sql_execute_duration",
      );
      assert.equal(executeDuration?.type, "Histogram");
      if (executeDuration?.type === "Histogram") {
        assert.equal(executeDuration.state.count, beforeCount + 6);
        assert.include(
          executeDuration.state.buckets.map(([boundary]) => boundary),
          2_000,
        );
      }
    }),
  );

  it.effect("records rolled-back SQLite transactions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE rollback_metric (value INTEGER)`;
      const beforeSnapshots = yield* Metric.snapshot;
      const beforeTransactionDuration = beforeSnapshots.find(
        (snapshot) =>
          snapshot.type === "Histogram" && snapshot.id === "t3_sqlite_transaction_duration",
      );
      const beforeCount =
        beforeTransactionDuration?.type === "Histogram" ? beforeTransactionDuration.state.count : 0;

      const exit = yield* Effect.exit(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO rollback_metric (value) VALUES (1)`;
            return yield* Effect.fail("rollback");
          }),
        ),
      );

      assert.isTrue(exit._tag === "Failure");
      const rows = yield* sql<{
        readonly count: number;
      }>`SELECT count(*) AS count FROM rollback_metric`;
      assert.equal(rows[0]?.count, 0);

      const snapshots = yield* Metric.snapshot;
      const transactionDuration = snapshots.find(
        (snapshot) =>
          snapshot.type === "Histogram" && snapshot.id === "t3_sqlite_transaction_duration",
      );
      assert.equal(transactionDuration?.type, "Histogram");
      if (transactionDuration?.type === "Histogram") {
        assert.equal(transactionDuration.state.count, beforeCount + 1);
      }
    }),
  );
});

it.effect("returns a typed failure when the database cannot be opened", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Layer.build(SqliteClient.layer({ filename: "\0" })).pipe(Effect.scoped),
    );

    assert.equal(error._tag, "SqlError");
    assert.equal(error.reason.operation, "open");
  }),
);

it.effect(
  "reserves the writer before reading so another connection cannot invalidate the transaction",
  () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-upgrade-"));
    const filename = NodePath.join(directory, "state.sqlite");
    const other = new NodeSqlite.DatabaseSync(filename);
    other.exec("PRAGMA journal_mode=WAL; CREATE TABLE entries(name TEXT NOT NULL)");

    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT name FROM entries`;
          yield* Effect.sync(() => assert.throws(() => other.exec("BEGIN IMMEDIATE"), /locked/));
          yield* sql`INSERT INTO entries VALUES ('first')`;
        }),
      );
      yield* Effect.sync(() =>
        other.exec("BEGIN IMMEDIATE; INSERT INTO entries VALUES ('second'); COMMIT"),
      );
      assert.deepEqual(yield* sql`SELECT name FROM entries ORDER BY rowid`, [
        { name: "first" },
        { name: "second" },
      ]);
    }).pipe(
      Effect.provide(SqliteClient.layer({ filename })),
      Effect.ensuring(
        Effect.sync(() => {
          other.close();
          NodeFS.rmSync(directory, { recursive: true, force: true });
        }),
      ),
    );
  },
);

it.effect("allows read-only transactions while another connection owns the writer", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-readonly-"));
  const filename = NodePath.join(directory, "state.sqlite");
  const writer = new NodeSqlite.DatabaseSync(filename);
  writer.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE entries(name TEXT); INSERT INTO entries VALUES ('saved'); BEGIN IMMEDIATE",
  );

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    assert.deepEqual(yield* sql.withTransaction(sql`SELECT name FROM entries`), [
      { name: "saved" },
    ]);
  }).pipe(
    Effect.provide(SqliteClient.layer({ filename, readonly: true })),
    Effect.ensuring(
      Effect.sync(() => {
        writer.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }),
    ),
  );
});
