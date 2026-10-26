// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as ServerConfig from "../config.ts";
import { runMigrations } from "./Migrations.ts";
import * as SqlitePersistence from "./Sqlite.ts";

it.effect("drops planner statistics a database already has", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-stats-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const persistence = () =>
    SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE walk_probe(node_id TEXT PRIMARY KEY, parent_node_id TEXT)`;
      yield* sql`INSERT INTO walk_probe VALUES ('node-1', NULL), ('node-2', 'node-1')`;
      yield* sql`ANALYZE walk_probe`;
    }).pipe(Effect.provide(persistence()));

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const stats = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM sqlite_stat1
      `;
      assert.equal(stats[0]?.count, 0);
      // A connection still using the old stats scans the table at each step.
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        WITH RECURSIVE retained(node_id) AS (
          SELECT 'node-2'
          UNION
          SELECT parent.parent_node_id FROM walk_probe AS parent
          INNER JOIN retained ON parent.node_id = retained.node_id
        )
        SELECT node_id FROM retained
      `;
      assert.include(
        plan.map((row) => row.detail),
        "SEARCH parent USING INDEX sqlite_autoindex_walk_probe_1 (node_id=?)",
      );
    }).pipe(Effect.provide(persistence()));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

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
      Effect.provide(
        SqlitePersistence.layerAttachedFromPath(dbPath).pipe(Layer.provide(NodeServices.layer)),
      ),
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
      Effect.provide(
        SqlitePersistence.layerAttachedFromPath(dbPath).pipe(Layer.provide(NodeServices.layer)),
      ),
    );
    const complete = yield* latestMigrationId.pipe(Effect.provide(SqlitePersistence.layerMemory));
    assert.equal(attached, complete);
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

const attachedThroughConfig = (directory: string) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return yield* latestMigrationId.pipe(
      Effect.provide(
        SqlitePersistence.layerConfigAttached.pipe(
          Layer.provide(
            ServerConfig.layer({ ...config, dbPath: NodePath.join(directory, "statev2.sqlite") }),
          ),
        ),
      ),
    );
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );

it.effect("attaches a CLI to the V1 database until a V2 server created its own", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-attach-v1-"));
  const v1Path = NodePath.join(tempDir, "state.sqlite");
  const v2Path = NodePath.join(tempDir, "statev2.sqlite");

  return Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 1 }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: v1Path })),
    );
    assert.equal(yield* attachedThroughConfig(tempDir), 1);
    assert.isFalse(NodeFS.existsSync(v2Path));

    yield* runMigrations({ toMigrationInclusive: 2 }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: v2Path })),
    );
    assert.equal(yield* attachedThroughConfig(tempDir), 2);
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
