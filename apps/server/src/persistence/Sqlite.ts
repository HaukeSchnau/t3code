import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "./Migrations.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import * as ServerConfig from "../config.ts";
import { sqlExecuteDuration, sqliteTransactionDuration } from "../observability/Metrics.ts";

const WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;

const configureConnection = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
  yield* sql`PRAGMA busy_timeout = 5000;`;
  yield* sql`PRAGMA foreign_keys = ON;`;
  // Existing databases need doctor's offline VACUUM to add pointer maps for this mode.
  const tables = yield* sql<{
    readonly count: number;
  }>`SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table'`;
  if (tables[0]?.count === 0) yield* sql`PRAGMA auto_vacuum = INCREMENTAL;`;
  yield* sql`PRAGMA journal_mode = WAL;`;
  // FULL fsyncs every event commit on the main thread; NORMAL syncs only at WAL checkpoints.
  // App crashes lose nothing; OS crashes or power loss can roll back post-checkpoint commits without corruption.
  yield* sql`PRAGMA synchronous = NORMAL;`;
  // macOS fsync misses drive caches; F_FULLFSYNC flushes them at checkpoints and is ignored elsewhere.
  yield* sql`PRAGMA checkpoint_fullfsync = ON;`;
  // PASSIVE checkpoints retain peak WAL size until the last connection closes.
  yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
});

const layerSetup = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* configureConnection;
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    // Collecting stats scans every page, and stale small-table stats cause scans after growth; use indexes by default.
    // Connections cache stats; reload after deleting them.
    const statTables = yield* sql`SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_stat1'`;
    if (statTables.length > 0) {
      yield* sql`DELETE FROM sqlite_stat1;`;
      yield* sql`ANALYZE sqlite_schema;`;
    }
  }),
);

// Only the server migrates a database it uses. A CLI from a newer release, such as a deploy's idle
// check, would otherwise rewrite the schema under the older running server and hold the write
// lock for as long as the migration takes. A database without a migrations table has no server
// yet, so the CLI may create it.
const layerAttachedSetup = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* configureConnection;
    const sql = yield* SqlClient.SqlClient;
    const migrationsTable = yield* sql`
      SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'effect_sql_migrations'
    `;
    if (migrationsTable.length === 0) yield* runMigrations();
  }),
);

const makeLayerFromPath = (name: string, setup: typeof layerSetup) =>
  Effect.fn(name)(function* (dbPath: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

    return Layer.provideMerge(
      setup,
      NodeSqliteClient.layer({
        filename: dbPath,
        readerWorker: true,
        // Run checkpoint fsyncs off the event loop so slow disk flushes cannot stall clients.
        checkpointWorker: true,
        spanAttributes: {
          "db.name": path.basename(dbPath),
          "service.name": "t3code-server",
        },
        timers: { statement: sqlExecuteDuration, transaction: sqliteTransactionDuration },
      }),
    );
  }, Layer.unwrap);

export const layerFromPath = makeLayerFromPath("makeSqlitePersistenceLive", layerSetup);

export const layerAttachedFromPath = makeLayerFromPath(
  "makeAttachedSqlitePersistence",
  layerAttachedSetup,
);

export const layerMemory = Layer.provideMerge(
  layerSetup,
  NodeSqliteClient.layer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    yield* initializeV2Database(dbPath);
    return layerFromPath(dbPath);
  }),
);

// Persistence for CLI commands that share the configured database with a server. Until a V2
// server has created its database, the running server is a V1 release that still uses the
// `state.sqlite` beside it (see initializeV2Database). A CLI must never create the V2 database,
// because the next V2 server start would then skip importing the V1 state.
export const layerConfigAttached = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const attachedPath = (yield* fs.exists(dbPath))
      ? dbPath
      : path.join(path.dirname(dbPath), "state.sqlite");
    return layerAttachedFromPath(attachedPath);
  }),
);
