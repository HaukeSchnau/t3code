import { assert, it } from "@effect/vitest";
import { EventId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { EventSinkV2, layer as eventSinkLayer } from "./EventSink.ts";
import { layer as eventStoreLayer } from "./EventStore.ts";
import {
  LegacyV1ThreadImporter,
  layer as legacyV1ThreadImporterLayer,
} from "./LegacyV1ThreadImporter.ts";
import {
  ProjectionMaintenanceV2,
  layer as projectionMaintenanceLayer,
} from "./ProjectionMaintenance.ts";
import { ProjectionStoreV2, layer as projectionStoreLayer } from "./ProjectionStore.ts";

const databaseLayer = SqlitePersistenceMemory;
const eventStoreProvided = eventStoreLayer.pipe(Layer.provideMerge(databaseLayer));
const projectionStoreProvided = projectionStoreLayer.pipe(Layer.provideMerge(databaseLayer));
const storesProvided = Layer.mergeAll(databaseLayer, eventStoreProvided, projectionStoreProvided);
const eventSinkProvided = eventSinkLayer.pipe(Layer.provide(storesProvided));
const importerProvided = legacyV1ThreadImporterLayer.pipe(
  Layer.provide(Layer.mergeAll(storesProvided, eventSinkProvided)),
);
const projectionMaintenanceProvided = projectionMaintenanceLayer.pipe(
  Layer.provide(storesProvided),
);
const TestLayer = Layer.mergeAll(
  storesProvided,
  eventSinkProvided,
  importerProvided,
  projectionMaintenanceProvided,
);

it.layer(TestLayer)("LegacyV1ThreadImporter", (it) => {
  it.effect("imports lightweight shells, hydrates transcripts, and remains idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter;
      const maintenance = yield* ProjectionMaintenanceV2;
      const projections = yield* ProjectionStoreV2;
      const eventSink = yield* EventSinkV2;
      const threadId = ThreadId.make("thread:legacy-import");

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          'project:legacy-import',
          'Legacy project',
          '/tmp/legacy-project',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          unsettled_at,
          snoozed_until,
          snoozed_at,
          pinned_at,
          pin_order_key,
          active_order_key,
          linked_pull_request_json,
          deleted_at
        ) VALUES (
          ${threadId},
          'project:legacy-import',
          'Migrated conversation',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access',
          'default',
          ' main ',
          ' /tmp/legacy-project ',
          NULL,
          '2026-01-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          NULL,
          NULL,
          NULL,
          '2026-01-03T12:00:00.000Z',
          '2026-02-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          'm',
          'g',
          '{"projectId":"project:legacy-import","repository":"pingdotgg/t3code","number":9000,"url":"https://github.com/pingdotgg/t3code/pull/9000"}',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        ) VALUES
          (
            'message:legacy:1',
            ${threadId},
            NULL,
            'user',
            'First question',
            '[]',
            0,
            '2026-01-01T01:00:00.000Z',
            '2026-01-01T01:00:00.000Z'
          ),
          (
            'message:legacy:2',
            ${threadId},
            NULL,
            'assistant',
            'First answer',
            '[]',
            0,
            '2026-01-02T01:00:00.000Z',
            '2026-01-02T01:00:00.000Z'
          ),
          (
            'message:legacy:3',
            ${threadId},
            NULL,
            'user',
            'Follow-up question',
            '[]',
            0,
            '2026-01-03T01:00:00.000Z',
            '2026-01-03T01:00:00.000Z'
          ),
          (
            'message:legacy:4',
            ${threadId},
            NULL,
            'assistant',
            'Partial answer',
            '[]',
            1,
            '2026-01-04T01:00:00.000Z',
            '2026-01-04T01:00:00.000Z'
        )
      `;

      yield* sql`
        UPDATE projection_threads
        SET workspace_id = 'workspace:legacy', title_mode = 'manual',
            skill_scope_json = '{"version":2,"appliedVersion":1,"packIds":["pack-legacy"],"state":"pending"}'
        WHERE thread_id = ${threadId}
      `;
      yield* sql`
        UPDATE projection_thread_messages
        SET origin_json = '{"type":"wait","waitId":"wait:legacy","state":"satisfied"}'
        WHERE message_id = 'message:legacy:1'
      `;
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode,
          status, last_seen_at, resume_cursor_json
        ) VALUES (
          ${threadId}, 'codex', 'codex', 'codex', 'full-access', 'stopped',
          '2026-01-04T00:00:00.000Z', '{"threadId":"native-existing-thread"}'
        )
      `;
      assert.equal(yield* importer.pendingThreadCount, 1);
      const shellImport = yield* importer.reconcileShells;
      assert.equal(yield* importer.pendingThreadCount, 1);
      assert.deepStrictEqual(shellImport, {
        importedThreadCount: 1,
        importedMessageCount: 2,
      });
      const shellEventCount = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
      `;
      assert.equal(shellEventCount[0]?.count, 7);

      const rebuilt = yield* maintenance.rebuild;
      assert.isTrue(rebuilt.valid);
      const shellProjection = yield* projections.getThreadProjection(threadId);
      assert.equal(shellProjection.thread.historyOrigin, "v1_import");
      assert.equal(shellProjection.providerThreads.length, 1);
      assert.equal(
        shellProjection.thread.activeProviderThreadId,
        shellProjection.providerThreads[0]?.id,
      );
      assert.equal(shellProjection.providerThreads[0]?.nativeThreadRef?.driver, "codex");
      assert.equal(
        shellProjection.providerThreads[0]?.nativeThreadRef?.nativeId,
        "native-existing-thread",
      );
      assert.equal(shellProjection.providerThreads[0]?.nativeThreadRef?.strength, "strong");
      assert.equal(shellProjection.providerThreads[0]?.providerSessionId, null);

      assert.equal(shellProjection.thread.workspaceId, "workspace:legacy");
      assert.equal(shellProjection.thread.titleMode, "manual");
      assert.equal(shellProjection.thread.skillScope?.version, 2);
      assert.equal(shellProjection.thread.skillScope?.appliedVersion, 1);
      assert.deepStrictEqual(shellProjection.thread.skillScope?.packIds.map(String), [
        "pack-legacy",
      ]);
      assert.equal(shellProjection.thread.skillScope?.state, "pending");
      assert.equal(shellProjection.thread.branch, "main");
      assert.equal(shellProjection.thread.worktreePath, "/tmp/legacy-project");
      assert.deepEqual(
        shellProjection.thread.pinnedAt,
        DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      );
      assert.equal(shellProjection.thread.pinOrderKey, "m");
      assert.equal(shellProjection.thread.activeOrderKey, "g");
      assert.deepEqual(
        shellProjection.thread.snoozedUntil,
        DateTime.makeUnsafe("2026-02-01T00:00:00.000Z"),
      );
      assert.deepEqual(
        shellProjection.thread.unsettledAt,
        DateTime.makeUnsafe("2026-01-03T12:00:00.000Z"),
      );
      assert.equal(shellProjection.thread.linkedPullRequest?.number, 9000);
      const shellSnapshot = yield* projections.getShellSnapshot();
      assert.equal(
        shellSnapshot.threads.find((thread) => thread.id === threadId)?.historyOrigin,
        "v1_import",
      );
      assert.deepStrictEqual(
        shellProjection.messages.map((message) => message.id),
        ["message:legacy:3", "message:legacy:4"],
      );

      const renamedAt = DateTime.makeUnsafe("2026-01-05T00:00:00.000Z");
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:legacy-import:metadata-after-shell"),
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId: shellProjection.thread.providerInstanceId,
            occurredAt: renamedAt,
            payload: {
              ...shellProjection.thread,
              title: "Renamed after shell import",
              runtimeMode: "approval-required",
              interactionMode: "plan",
              archivedAt: renamedAt,
              settledOverride: "settled",
              settledAt: renamedAt,
              updatedAt: renamedAt,
            },
          },
        ],
      });

      const transcriptImport = yield* importer.ensureTranscript(threadId);
      assert.equal(yield* importer.pendingThreadCount, 0);
      assert.deepStrictEqual(transcriptImport, {
        importedThreadCount: 1,
        importedMessageCount: 2,
      });
      const projection = yield* projections.getThreadProjection(threadId);
      assert.equal(projection.thread.title, "Renamed after shell import");
      const importedOrigin = projection.messages.find(
        (message) => message.id === "message:legacy:1",
      )?.origin;
      const importedWaitOrigin = importedOrigin?.type === "wait" ? importedOrigin : undefined;
      assert.equal(importedOrigin?.type, "wait");
      assert.equal(String(importedWaitOrigin?.waitId), "wait:legacy");
      assert.equal(importedWaitOrigin?.state, "satisfied");
      assert.equal(projection.thread.runtimeMode, "approval-required");
      assert.equal(projection.thread.interactionMode, "plan");
      assert.deepEqual(projection.thread.archivedAt, renamedAt);
      assert.equal(projection.thread.settledOverride, "settled");
      assert.deepEqual(projection.thread.settledAt, renamedAt);
      assert.deepStrictEqual(
        projection.messages.map((message) => message.id),
        ["message:legacy:1", "message:legacy:2", "message:legacy:3", "message:legacy:4"],
      );
      assert.deepStrictEqual(
        projection.turnItems
          .filter(
            (
              item,
            ): item is Extract<
              (typeof projection.turnItems)[number],
              { readonly type: "user_message" | "assistant_message" }
            > => item.type === "user_message" || item.type === "assistant_message",
          )
          .map((item) => [item.messageId, item.ordinal, item.status]),
        [
          ["message:legacy:1", 1, "completed"],
          ["message:legacy:2", 2, "completed"],
          ["message:legacy:3", 3, "completed"],
          ["message:legacy:4", 4, "interrupted"],
        ],
      );

      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:legacy-import:explicit-unpin"),
            type: "thread.unpinned",
            threadId,
            providerInstanceId: projection.thread.providerInstanceId,
            occurredAt: renamedAt,
            payload: { ...projection.thread, pinnedAt: null, pinOrderKey: null },
          },
        ],
      });
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_remove(
          payload_json,
          '$.snoozedUntil',
          '$.snoozedAt',
          '$.unsettledAt',
          '$.activeOrderKey',
          '$.linkedPullRequest'
        )
        WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 1,
        importedMessageCount: 0,
      });
      const repaired = yield* projections.getThreadProjection(threadId);
      assert.isNull(repaired.thread.pinnedAt);
      assert.isNull(repaired.thread.pinOrderKey);
      assert.equal(repaired.thread.activeOrderKey, "g");
      assert.deepEqual(
        repaired.thread.snoozedUntil,
        DateTime.makeUnsafe("2026-02-01T00:00:00.000Z"),
      );
      assert.deepEqual(
        repaired.thread.unsettledAt,
        DateTime.makeUnsafe("2026-01-03T12:00:00.000Z"),
      );
      assert.equal(repaired.thread.linkedPullRequest?.number, 9000);
      const eventCountBeforeRetry = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
      `;
      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 0,
        importedMessageCount: 0,
      });
      assert.deepStrictEqual(yield* importer.ensureTranscript(threadId), {
        importedThreadCount: 0,
        importedMessageCount: 0,
      });
      const eventCountAfterRetry = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
      `;
      assert.equal(eventCountAfterRetry[0]?.count, eventCountBeforeRetry[0]?.count);
    }),
  );
});

it.layer(TestLayer)("LegacyV1ThreadImporter queued work", (it) => {
  it.effect("imports FIFO queue identities and preserves a legacy stop", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter;
      const maintenance = yield* ProjectionMaintenanceV2;
      const projections = yield* ProjectionStoreV2;
      const threadId = ThreadId.make("thread:legacy-queue-import");

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project:legacy-queue-import', 'Queue project', '/tmp/queue-project',
          '{"instanceId":"codex","model":"gpt-5.4"}', '[]',
          '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, branch, worktree_path, latest_turn_id, created_at,
          updated_at, archived_at, settled_override, settled_at, unsettled_at,
          snoozed_until, snoozed_at, pinned_at, pin_order_key,
          linked_pull_request_json, deleted_at
        ) VALUES (
          ${threadId}, 'project:legacy-queue-import', 'Queued legacy thread',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
          NULL, NULL, 'turn:legacy-stop', '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          NULL, NULL, NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json,
          is_streaming, created_at, updated_at
        ) VALUES (
          'message:legacy-stop', ${threadId}, 'turn:legacy-stop', 'user',
          'Stopped prompt', '[]', 0, '2026-01-01T01:00:00.000Z',
          '2026-01-01T01:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, source_proposed_plan_thread_id,
          source_proposed_plan_id, assistant_message_id, state, requested_at,
          started_at, completed_at, checkpoint_turn_count, checkpoint_ref,
          checkpoint_status, checkpoint_files_json
        ) VALUES (
          ${threadId}, 'turn:legacy-stop', 'message:legacy-stop', NULL, NULL, NULL,
          'error', '2026-01-01T01:00:00.000Z', '2026-01-01T01:00:01.000Z',
          '2026-01-01T01:00:02.000Z', NULL, NULL, NULL, '[]'
        )
      `;
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode,
          status, last_seen_at, resume_cursor_json
        ) VALUES (
          ${threadId}, 'codex', 'codex', 'codex', 'full-access', 'stopped',
          '2026-01-01T00:30:00.000Z', '{"threadId":"native-queue-codex"}'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_queued_messages (
          message_id, thread_id, text, attachments_json, origin_json,
          model_selection_json, title_seed, runtime_mode, interaction_mode,
          source_proposed_plan_thread_id, source_proposed_plan_id, created_at,
          updated_at
        ) VALUES
          (
            'message:legacy-queue:a', ${threadId}, 'First queued prompt', '[]',
            '{"type":"wait","waitId":"wait:legacy-queue","state":"satisfied"}',
            '{"instanceId":"codex","model":"gpt-5.4"}', NULL,
            'approval-required', 'plan', NULL, NULL,
            '2026-01-01T02:00:00.000Z', '2026-01-01T02:00:01.000Z'
          ),
          (
            'message:legacy-queue:b', ${threadId}, 'Second queued prompt',
            '[{"type":"file","id":"queue-file","name":"notes.txt","mimeType":"text/plain","sizeBytes":5}]', NULL,
            '{"instanceId":"claudex","model":"claude-sonnet"}', NULL,
            'full-access', 'default', NULL, NULL,
            '2026-01-01T01:30:00.000Z', '2026-01-01T01:30:01.000Z'
          )
      `;

      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 1,
        importedMessageCount: 3,
      });
      assert.isTrue((yield* maintenance.rebuild).valid);
      const projection = yield* projections.getThreadProjection(threadId);
      assert.deepStrictEqual(
        projection.runs.map((run) => [
          String(run.status),
          run.queuePosition ?? null,
          String(run.modelSelection.instanceId),
          String(run.runtimeMode),
          String(run.interactionMode),
        ]),
        [
          ["failed", null, "codex", "full-access", "default"],
          ["queued", 1, "claudex", "full-access", "default"],
          ["queued", 2, "codex", "approval-required", "plan"],
        ],
      );
      assert.deepStrictEqual(
        projection.messages
          .filter((message) => message.id.startsWith("message:legacy-queue:"))
          .map((message) => [
            String(message.id),
            message.text,
            message.attachments.map((attachment) => String(attachment.id)),
          ]),
        [
          ["message:legacy-queue:b", "Second queued prompt", ["queue-file"]],
          ["message:legacy-queue:a", "First queued prompt", []],
        ],
      );
      const queuedOrigin = projection.messages.find(
        (message) => message.id === "message:legacy-queue:a",
      )?.origin;
      const queuedWaitOrigin = queuedOrigin?.type === "wait" ? queuedOrigin : undefined;
      assert.equal(queuedOrigin?.type, "wait");
      assert.equal(String(queuedWaitOrigin?.waitId), "wait:legacy-queue");
      assert.equal(queuedWaitOrigin?.state, "satisfied");
      assert.deepStrictEqual(
        projection.providerThreads.map((providerThread) => [
          String(providerThread.providerInstanceId),
          String(providerThread.driver),
          providerThread.nativeThreadRef?.nativeId ?? null,
        ]),
        [
          ["codex", "codex", "native-queue-codex"],
          ["claudex", "claudeAgent", null],
        ],
      );
      const eventCountBeforeRetry = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE application_event_version = 2 AND stream_id = ${threadId}
      `;
      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 0,
        importedMessageCount: 0,
      });
      const eventCountAfterRetry = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE application_event_version = 2 AND stream_id = ${threadId}
      `;
      assert.equal(eventCountAfterRetry[0]?.count, eventCountBeforeRetry[0]?.count);
    }),
  );
});

it.layer(TestLayer)("LegacyV1ThreadImporter provider bindings", (it) => {
  it.effect("maps Cursor and OpenCode session ids and ignores placeholder ids", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter;
      const maintenance = yield* ProjectionMaintenanceV2;
      const projections = yield* ProjectionStoreV2;
      const cursorThreadId = ThreadId.make("thread:legacy-cursor-session");
      const openCodeSessionThreadId = ThreadId.make("thread:legacy-opencode-session");
      const openCodeThreadId = ThreadId.make("thread:legacy-opencode-no-session");

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project:legacy-provider-bindings', 'Provider project', '/tmp/provider-project',
          '{"instanceId":"cursor","model":"gpt-5.4"}', '[]',
          '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, branch, worktree_path, latest_turn_id, created_at,
          updated_at, archived_at, settled_override, settled_at, unsettled_at,
          snoozed_until, snoozed_at, pinned_at, pin_order_key,
          linked_pull_request_json, deleted_at
        ) VALUES
          (
            ${cursorThreadId}, 'project:legacy-provider-bindings', 'Cursor session',
            '{"instanceId":"cursor","model":"gpt-5.4"}', 'full-access', 'default',
            NULL, NULL, NULL, '2026-01-01T00:00:00.000Z',
            '2026-01-02T00:00:00.000Z', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
            NULL, NULL, NULL
          ),
          (
            ${openCodeSessionThreadId}, 'project:legacy-provider-bindings', 'OpenCode session',
            '{"instanceId":"opencode","model":"gpt-5.4"}', 'full-access', 'default',
            NULL, NULL, NULL, '2026-01-01T00:00:00.000Z',
            '2026-01-02T00:00:00.000Z', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
            NULL, NULL, NULL
          ),
          (
            ${openCodeThreadId}, 'project:legacy-provider-bindings', 'OpenCode session missing',
            '{"instanceId":"opencode","model":"gpt-5.4"}', 'full-access', 'default',
            NULL, NULL, NULL, '2026-01-01T00:00:00.000Z',
            '2026-01-02T00:00:00.000Z', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
            NULL, NULL, NULL
          )
      `;
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode,
          status, last_seen_at, resume_cursor_json
        ) VALUES
          (
            ${cursorThreadId}, 'cursor', 'cursor', 'cursor', 'full-access', 'stopped',
            '2026-01-02T00:00:00.000Z', '{"threadId":"0","sessionId":"cursor-session-27"}'
          ),
          (
            ${openCodeSessionThreadId}, 'opencode', 'opencode', 'opencode', 'full-access', 'stopped',
            '2026-01-02T00:00:00.000Z', '{"threadId":"0","sessionId":"opencode-session-15"}'
          ),
          (
            ${openCodeThreadId}, 'opencode', 'opencode', 'opencode', 'full-access', 'stopped',
            '2026-01-02T00:00:00.000Z', '{"threadId":"0"}'
          )
      `;

      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 3,
        importedMessageCount: 0,
      });
      assert.isTrue((yield* maintenance.rebuild).valid);

      const cursorProjection = yield* projections.getThreadProjection(cursorThreadId);
      assert.deepStrictEqual(
        cursorProjection.providerThreads.map((providerThread) => [
          String(providerThread.providerInstanceId),
          String(providerThread.driver),
          providerThread.nativeThreadRef?.nativeId ?? null,
        ]),
        [["cursor", "cursor", "cursor-session-27"]],
      );
      assert.equal(
        cursorProjection.thread.activeProviderThreadId,
        cursorProjection.providerThreads[0]?.id,
      );

      const openCodeProjection = yield* projections.getThreadProjection(openCodeSessionThreadId);
      assert.deepStrictEqual(
        openCodeProjection.providerThreads.map((providerThread) => [
          String(providerThread.providerInstanceId),
          String(providerThread.driver),
          providerThread.nativeThreadRef?.nativeId ?? null,
        ]),
        [["opencode", "opencode", "opencode-session-15"]],
      );
      assert.equal(
        openCodeProjection.thread.activeProviderThreadId,
        openCodeProjection.providerThreads[0]?.id,
      );

      const openCodeNoSessionProjection = yield* projections.getThreadProjection(openCodeThreadId);
      assert.deepStrictEqual(openCodeNoSessionProjection.providerThreads, []);
      assert.isNull(openCodeNoSessionProjection.thread.activeProviderThreadId);
    }),
  );
});
