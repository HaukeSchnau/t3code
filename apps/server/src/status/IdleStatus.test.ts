import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { getServerIdleStatus } from "./IdleStatus.ts";

const at = "2026-10-01T00:00:00.000Z";

const insertThread = (threadId: string, deletedAt: string | null = null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, deleted_at, payload_json
      ) VALUES (
        ${threadId}, 'project', 'Thread', 'codex', 'full-access', 'default',
        ${at}, ${at}, ${deletedAt}, '{}'
      )
    `;
  });

const insertRun = (threadId: string, ordinal: number, status: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, status, requested_at, payload_json
      ) VALUES (${`${threadId}:run:${ordinal}`}, ${threadId}, ${ordinal}, 'codex', ${status}, ${at}, '{}')
    `;
  });

const insertSession = (threadId: string, status: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sessionId = `${threadId}:session`;
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_sessions (
        provider_session_id, thread_id, provider, status, updated_at, payload_json
      ) VALUES (${sessionId}, ${threadId}, 'codex', ${status}, ${at}, '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_session_bindings (provider_session_id, thread_id)
      VALUES (${sessionId}, ${threadId})
    `;
  });

const insertRequest = (threadId: string, kind: string, responseType: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runtime_requests (
        runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json
      ) VALUES (
        ${`${threadId}:${kind}:${responseType}`}, ${threadId}, 'node', ${kind}, 'pending', ${at},
        ${`{"responseCapability":{"type":"${responseType}"}}`}
      )
    `;
  });

const insertEffect = (threadId: string, effectType: string, status: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_effect_outbox (
        effect_id, command_id, thread_id, effect_type, payload_json, status,
        available_at, created_at, updated_at
      ) VALUES (
        ${`${threadId}:${effectType}`}, 'command', ${threadId}, ${effectType}, '{}', ${status},
        ${at}, ${at}, ${at}
      )
    `;
  });

const busyReasons = Effect.map(getServerIdleStatus(), (status) =>
  status.busyThreads.map((thread) => `${thread.threadId}:${thread.reason}`).toSorted(),
);

it.effect("blocks restart on work that dies with the server process", () =>
  Effect.gen(function* () {
    for (const threadId of ["preparing", "running", "session", "approval", "effect"]) {
      yield* insertThread(threadId);
    }
    yield* insertRun("preparing", 1, "preparing");
    yield* insertRun("running", 1, "waiting");
    yield* insertSession("session", "running");
    yield* insertRequest("approval", "command", "live");
    yield* insertEffect("effect", "provider-turn.start", "pending");

    const status = yield* getServerIdleStatus();
    assert.isFalse(status.idle);
    assert.equal(status.busyThreadCount, 5);
    assert.equal(status.projectedRunningTurnCount, 1);
    assert.equal(status.projectedActiveTurnCount, 1);
    assert.equal(status.pendingApprovalCount, 1);
    assert.deepEqual(yield* busyReasons, [
      "approval:pending-approval",
      "effect:command-in-progress",
      "preparing:command-in-progress",
      "running:projected-latest-turn-running",
      "session:projected-active-turn",
    ]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("counts durable work without blocking restart", () =>
  Effect.gen(function* () {
    yield* insertThread("thread");
    yield* insertThread("deleted", at);
    yield* insertRun("thread", 1, "completed");
    yield* insertRun("thread", 2, "queued");
    yield* insertSession("thread", "ready");
    yield* insertRequest("thread", "user_input", "message");
    yield* insertEffect("thread", "checkpoint.capture", "running");
    yield* insertEffect("thread", "provider-turn.interrupt", "succeeded");
    yield* insertRun("deleted", 1, "running");

    const status = yield* getServerIdleStatus();
    assert.isTrue(status.idle);
    assert.equal(status.busyThreadCount, 0);
    assert.equal(status.queuedMessageCount, 1);
    assert.equal(status.pendingUserInputCount, 1);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
