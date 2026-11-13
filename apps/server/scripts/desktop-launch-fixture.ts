#!/usr/bin/env node
// Builds the database `scripts/smoke-desktop-app.ts` launches the desktop app against: one project
// and two threads, written by this build's migrations and its V1 thread importer, as a server
// leaves them. See patches/fast-project-qa.md for which revision the committed fixture comes from.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { Command, Flag } from "effect/cli";

import * as EventSink from "../src/orchestration-v2/EventSink.ts";
import * as EventStore from "../src/orchestration-v2/EventStore.ts";
import * as LegacyV1ThreadImporter from "../src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import * as Sqlite from "../src/persistence/Sqlite.ts";

const PROJECT_ID = "launch-check-project";
const MODEL = '{"instanceId":"codex","model":"gpt-5.4"}';
// The launch check finds the first thread by title and waits for its assistant message.
const THREADS = [
  {
    id: "launch-check-other",
    title: "Second thread",
    messages: [["user", "A second thread so the sidebar has a list."]],
  },
  {
    id: "launch-check-thread",
    title: "Release launch check",
    messages: [
      ["user", "Does the release open?"],
      ["assistant", "The release opens and shows this thread."],
    ],
  },
] as const;
const CREATED_AT = "2026-10-27T10:00:00.000Z";

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json, scripts_json,
      created_at, updated_at
    ) VALUES (
      ${PROJECT_ID}, 'Launch Check', '/tmp/t3-launch-check-workspace', ${MODEL}, '[]',
      ${CREATED_AT}, ${CREATED_AT}
    )
  `;
  for (const thread of THREADS) {
    // Threads idle past the auto-settle window leave the sidebar's active list.
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        created_at, updated_at, auto_settle_disabled_at
      ) VALUES (
        ${thread.id}, ${PROJECT_ID}, ${thread.title}, ${MODEL}, 'full-access', 'default',
        ${CREATED_AT}, ${CREATED_AT}, ${CREATED_AT}
      )
    `;
    for (const [index, [role, text]] of thread.messages.entries()) {
      const at = `2026-10-27T10:0${index}:00.000Z`;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, attachments_json, is_streaming, created_at, updated_at
        ) VALUES (
          ${`${thread.id}-${role}`}, ${thread.id}, ${role}, ${text}, '[]', 0,
          ${at}, ${at}
        )
      `;
    }
  }
  const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
  yield* importer.reconcileShells;
  const imported = yield* importer.importPendingTranscripts;
  if (imported.importedThreadCount !== THREADS.length) {
    return yield* Effect.die(
      `Imported ${imported.importedThreadCount} threads, not ${THREADS.length}.`,
    );
  }
});

const persistence = (databasePath: string) => {
  const database = Sqlite.layerFromPath(databasePath);
  const stores = Layer.mergeAll(
    database,
    EventStore.layer.pipe(Layer.provideMerge(database)),
    ProjectionStore.layer.pipe(Layer.provideMerge(database)),
  );
  const eventSink = EventSink.layer.pipe(Layer.provide(stores));
  return Layer.mergeAll(
    stores,
    LegacyV1ThreadImporter.layer.pipe(Layer.provide(Layer.mergeAll(stores, eventSink))),
  );
};

const command = Command.make(
  "desktop-launch-fixture",
  {
    output: Flag.String("output").pipe(
      Flag.withDescription("Where the fixture database goes. An existing file is replaced."),
    ),
  },
  Effect.fn("desktopLaunchFixture")(function* ({ output }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const outputPath = path.resolve(output);
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-launch-fixture-" });
    const databasePath = path.join(directory, "statev2.sqlite");

    yield* Effect.gen(function* () {
      yield* seed;
      yield* fs.remove(outputPath, { force: true });
      // One file without WAL, compacted.
      yield* (yield* SqlClient.SqlClient)`VACUUM INTO ${outputPath}`;
    }).pipe(Effect.provide(persistence(databasePath)));
    yield* Console.log(`Wrote ${outputPath}`);
  }, Effect.scoped),
);

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
