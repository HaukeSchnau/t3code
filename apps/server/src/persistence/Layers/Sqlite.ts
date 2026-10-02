import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

import { runMigrations } from "../Migrations.ts";
import { ServerConfig } from "../../config.ts";

const configureConnection = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
  yield* sql`PRAGMA busy_timeout = 5000;`;
  yield* sql`PRAGMA foreign_keys = ON;`;
  yield* sql`PRAGMA journal_mode = WAL;`;
});

const setup = Layer.effectDiscard(configureConnection.pipe(Effect.andThen(runMigrations())));

// Only the server migrates a database it uses. A CLI from a newer release, such as a deploy's idle
// check, would otherwise rewrite the schema under the older running server and hold the write
// lock for as long as the migration takes. A database without a migrations table has no server
// yet, so the CLI may create it.
const attachedSetup = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* configureConnection;
    const sql = yield* SqlClient.SqlClient;
    const migrationsTable = yield* sql`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
    `;
    if (migrationsTable.length === 0) {
      yield* runMigrations();
    }
  }),
);

const makePersistence = (name: string, setupLayer: typeof setup) =>
  Effect.fn(name)(function* (dbPath: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

    return Layer.provideMerge(
      setupLayer,
      NodeSqliteClient.layer({
        filename: dbPath,
        spanAttributes: {
          "db.name": path.basename(dbPath),
          "service.name": "t3-server",
        },
      }),
    );
  }, Layer.unwrap);

export const makeSqlitePersistenceLive = makePersistence("makeSqlitePersistenceLive", setup);

export const makeAttachedSqlitePersistence = makePersistence(
  "makeAttachedSqlitePersistence",
  attachedSetup,
);

export const SqlitePersistenceMemory = Layer.provideMerge(
  setup,
  NodeSqliteClient.layer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    return makeSqlitePersistenceLive(dbPath);
  }),
);

// Persistence for CLI commands that share the configured database with a server.
export const layerConfigAttached = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    return makeAttachedSqlitePersistence(dbPath);
  }),
);
