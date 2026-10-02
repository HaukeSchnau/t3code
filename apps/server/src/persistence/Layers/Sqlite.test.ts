// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { runMigrations } from "../Migrations.ts";
import {
  SqlitePersistenceMemory,
  makeAttachedSqlitePersistence,
  makeSqlitePersistenceLive,
} from "./Sqlite.ts";

const lockHolderSource = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("BEGIN IMMEDIATE");
process.stdout.write("locked\\n");
setTimeout(() => {
  db.exec("COMMIT");
  db.close();
}, Number(process.argv[2]));
`;

const spawnWriteLockHolder = (dbPath: string, holdMs: number) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        const holder = NodeChildProcess.spawn(
          process.execPath,
          ["-e", lockHolderSource, dbPath, String(holdMs)],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
        holder.stdout.once("data", () => resolve());
        holder.on("error", reject);
        holder.on("exit", () =>
          reject(new Error("lock holder exited before acquiring the write lock")),
        );
      }),
  );

it.effect("waits out a concurrent writer instead of failing with SQLITE_BUSY", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-busy-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE busy_probe(id INTEGER PRIMARY KEY)`;
    yield* spawnWriteLockHolder(dbPath, 300);
    yield* sql`INSERT INTO busy_probe(id) VALUES (${1})`;
    const rows = yield* sql<{ readonly id: number }>`SELECT id FROM busy_probe`;
    assert.deepEqual([...rows], [{ id: 1 }]);
  }).pipe(
    Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("applies busy_timeout in the shared persistence setup", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly timeout: number }>`PRAGMA busy_timeout`;
    assert.equal(rows[0]?.timeout, 5000);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

const latestMigrationId = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly id: number }>`
    SELECT MAX(migration_id) AS id FROM effect_sql_migrations
  `;
  return rows[0]?.id;
});

it.effect("leaves a server's database schema alone when a CLI attaches", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-attach-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    // A server from an older release migrated this database up to its own last migration.
    yield* runMigrations({ toMigrationInclusive: 1 }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: dbPath })),
    );
    const attached = yield* latestMigrationId.pipe(
      Effect.provide(makeAttachedSqlitePersistence(dbPath).pipe(Layer.provide(NodeServices.layer))),
    );
    assert.equal(attached, 1);
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("creates the schema when a CLI attaches before any server ran", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-attach-new-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    const attached = yield* latestMigrationId.pipe(
      Effect.provide(makeAttachedSqlitePersistence(dbPath).pipe(Layer.provide(NodeServices.layer))),
    );
    const complete = yield* latestMigrationId.pipe(Effect.provide(SqlitePersistenceMemory));
    assert.equal(attached, complete);
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
