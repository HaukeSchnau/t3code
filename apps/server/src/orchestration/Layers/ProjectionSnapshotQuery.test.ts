import {
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { encodeThreadDetailPageCursor } from "../threadDetailCursor.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.make(value);

const projectionSnapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(ThreadPlanProgress.layer),
  ),
);

projectionSnapshotLayer("ProjectionSnapshotQuery", (it) => {
  it.effect("reads restart safety from narrow normalized projection state", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM provider_transcript_journal`;
      yield* sql`DELETE FROM projection_thread_queued_messages`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json, scripts_json,
          created_at, updated_at, deleted_at
        ) VALUES ('project-restart', 'Restart', '/tmp/restart', NULL, '[]',
          '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z', NULL)
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          branch, worktree_path, latest_turn_id, latest_user_message_at,
          pending_approval_count, pending_user_input_count, has_actionable_proposed_plan,
          created_at, updated_at, deleted_at
        ) VALUES (
          'thread-restart', 'project-restart', 'Restart thread',
          '{"instanceId":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          NULL, NULL, 'turn-restart', NULL, 2, 3, 0,
          '2026-07-15T00:00:00.000Z', '2026-07-15T14:28:38.073Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, active_turn_id, last_error, updated_at,
          runtime_mode, provider_instance_id
        ) VALUES (
          'thread-restart', 'running', 'codex', 'turn-restart', NULL,
          '2026-07-15T14:28:38.073Z', 'full-access', 'codex'
        )
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, started_at, completed_at, checkpoint_files_json
        ) VALUES (
          'thread-restart', 'turn-restart', 'running', '2026-07-15T14:28:38.073Z',
          '2026-07-15T14:28:38.073Z', NULL, '[]'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_queued_messages (
          message_id, thread_id, text, attachments_json, runtime_mode, interaction_mode,
          created_at, updated_at
        ) VALUES (
          'queued-restart', 'thread-restart', 'next', '[]', 'full-access', 'default',
          '2026-07-15T15:00:00.000Z', '2026-07-15T15:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO provider_transcript_journal (
          provider_instance_id, event_id, thread_id, turn_id, completes_item, delivered, event_json
        ) VALUES ('codex', 'event-restart', 'thread-restart', 'turn-restart', 0, 0, '{}')
      `;

      const state = yield* snapshotQuery.getRestartSafetyState!();
      assert.equal(state.threads.length, 1);
      assert.deepStrictEqual(state.threads[0], {
        threadId: ThreadId.make("thread-restart"),
        session: {
          threadId: ThreadId.make("thread-restart"),
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: TurnId.make("turn-restart"),
          lastError: null,
          updatedAt: "2026-07-15T14:28:38.073Z",
        },
        latestTurnId: TurnId.make("turn-restart"),
        latestTurnState: "running",
        latestTurnUpdatedAt: "2026-07-15T14:28:38.073Z",
        queuedMessageCount: 1,
        pendingApprovalCount: 2,
        pendingUserInputCount: 3,
        undeliveredTranscriptEventCount: 1,
      });
      yield* sql`DELETE FROM provider_transcript_journal`;
      yield* sql`DELETE FROM projection_thread_queued_messages`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
    }),
  );

  it.effect("hydrates read model from projection tables and computes snapshot sequence", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_turns`;

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
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:01.000Z',
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
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          pinned_at,
          pin_order_key,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-1',
          '2026-02-24T00:00:04.000Z',
          1,
          0,
          0,
          '2026-02-24T00:00:01.000Z',
          'gm',
          '2026-02-24T00:00:02.000Z',
          '2026-02-24T00:00:03.000Z',
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
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'message-1',
          'thread-1',
          'turn-1',
          'assistant',
          'hello from projection',
          0,
          '2026-02-24T00:00:04.000Z',
          '2026-02-24T00:00:05.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          implemented_at,
          implementation_thread_id,
          created_at,
          updated_at
        )
        VALUES (
          'plan-1',
          'thread-1',
          'turn-1',
          '# Ship it',
          '2026-02-24T00:00:05.500Z',
          'thread-2',
          '2026-02-24T00:00:05.000Z',
          '2026-02-24T00:00:05.500Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_queued_messages (
          message_id,
          thread_id,
          text,
          attachments_json,
          model_selection_json,
          title_seed,
          runtime_mode,
          interaction_mode,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          created_at,
          updated_at
        )
        VALUES (
          'message-queued-1',
          'thread-1',
          'queued from projection',
          '[]',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'Queued title',
          'full-access',
          'default',
          'thread-1',
          'plan-1',
          '2026-02-24T00:00:05.600Z',
          '2026-02-24T00:00:05.600Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at
        )
        VALUES (
          'activity-1',
          'thread-1',
          'turn-1',
          'info',
          'runtime.note',
          'provider started',
          '{"stage":"start"}',
          '2026-02-24T00:00:06.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          'thread-1',
          'running',
          'codex',
          'provider-session-1',
          'provider-thread-1',
          'approval-required',
          'turn-1',
          NULL,
          '2026-02-24T00:00:07.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-1',
          'turn-1',
          NULL,
          'thread-1',
          'plan-1',
          'message-1',
          'completed',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          1,
          'checkpoint-1',
          'ready',
          '[{"path":"README.md","kind":"modified","additions":2,"deletions":1}]'
        )
      `;

      let sequence = 5;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (
            projector,
            last_applied_sequence,
            updated_at
          )
          VALUES (
            ${projector},
            ${sequence},
            '2026-02-24T00:00:09.000Z'
          )
        `;
        sequence += 1;
      }

      const snapshot = yield* snapshotQuery.getSnapshot();

      assert.equal(snapshot.snapshotSequence, 5);
      assert.equal(snapshot.updatedAt, "2026-02-24T00:00:09.000Z");
      assert.deepEqual(snapshot.projects, [
        {
          id: asProjectId("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          repositoryIdentity: null,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          scripts: [
            {
              id: "script-1",
              name: "Build",
              command: "bun run build",
              icon: "build",
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
          deletedAt: null,
        },
      ]);
      assert.deepEqual(snapshot.threads, [
        {
          id: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          workspaceId: null,
          latestTurn: {
            turnId: asTurnId("turn-1"),
            state: "completed",
            requestedAt: "2026-02-24T00:00:08.000Z",
            startedAt: "2026-02-24T00:00:08.000Z",
            completedAt: "2026-02-24T00:00:08.000Z",
            assistantMessageId: asMessageId("message-1"),
            sourceProposedPlan: {
              threadId: ThreadId.make("thread-1"),
              planId: "plan-1",
            },
          },
          createdAt: "2026-02-24T00:00:02.000Z",
          updatedAt: "2026-02-24T00:00:03.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          pinnedAt: "2026-02-24T00:00:01.000Z",
          pinOrderKey: "gm",
          titleRegeneration: null,
          deletedAt: null,
          messages: [
            {
              id: asMessageId("message-1"),
              role: "assistant",
              text: "hello from projection",
              turnId: asTurnId("turn-1"),
              streaming: false,
              createdAt: "2026-02-24T00:00:04.000Z",
              updatedAt: "2026-02-24T00:00:05.000Z",
            },
          ],
          queuedMessages: [
            {
              messageId: asMessageId("message-queued-1"),
              threadId: ThreadId.make("thread-1"),
              text: "queued from projection",
              attachments: [],
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5-codex",
              },
              titleSeed: "Queued title",
              runtimeMode: "full-access",
              interactionMode: "default",
              sourceProposedPlan: {
                threadId: ThreadId.make("thread-1"),
                planId: "plan-1",
              },
              createdAt: "2026-02-24T00:00:05.600Z",
              updatedAt: "2026-02-24T00:00:05.600Z",
            },
          ],
          proposedPlans: [
            {
              id: "plan-1",
              turnId: asTurnId("turn-1"),
              planMarkdown: "# Ship it",
              implementedAt: "2026-02-24T00:00:05.500Z",
              implementationThreadId: ThreadId.make("thread-2"),
              createdAt: "2026-02-24T00:00:05.000Z",
              updatedAt: "2026-02-24T00:00:05.500Z",
            },
          ],
          activities: [
            {
              id: asEventId("activity-1"),
              tone: "info",
              kind: "runtime.note",
              summary: "provider started",
              payload: { stage: "start" },
              turnId: asTurnId("turn-1"),
              createdAt: "2026-02-24T00:00:06.000Z",
            },
          ],
          historicalActivityGroups: [],
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-1"),
              status: "ready",
              files: [{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }],
              assistantMessageId: asMessageId("message-1"),
              completedAt: "2026-02-24T00:00:08.000Z",
            },
          ],
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: "2026-02-24T00:00:07.000Z",
          },
        },
      ]);

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.snapshotSequence, 5);
      assert.deepEqual(shellSnapshot.projects, [
        {
          id: asProjectId("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          repositoryIdentity: null,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          scripts: [
            {
              id: "script-1",
              name: "Build",
              command: "bun run build",
              icon: "build",
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
        },
      ]);
      assert.deepEqual(shellSnapshot.threads, [
        {
          id: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          workspaceId: null,
          latestTurn: {
            turnId: asTurnId("turn-1"),
            state: "completed",
            requestedAt: "2026-02-24T00:00:08.000Z",
            startedAt: "2026-02-24T00:00:08.000Z",
            completedAt: "2026-02-24T00:00:08.000Z",
            assistantMessageId: asMessageId("message-1"),
            sourceProposedPlan: {
              threadId: ThreadId.make("thread-1"),
              planId: "plan-1",
            },
          },
          createdAt: "2026-02-24T00:00:02.000Z",
          updatedAt: "2026-02-24T00:00:03.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          pinnedAt: "2026-02-24T00:00:01.000Z",
          pinOrderKey: "gm",
          titleRegeneration: null,
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: "2026-02-24T00:00:07.000Z",
          },
          latestUserMessageAt: "2026-02-24T00:00:04.000Z",
          hasPendingApprovals: true,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          backgroundLiveness: null,
          planProgress: null,
        },
      ]);

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.deepEqual(threadDetail.value, snapshot.threads[0]);
      }

      const commandReadModel = yield* snapshotQuery.getCommandReadModel();
      assert.deepEqual(commandReadModel.threads[0]?.queuedMessages, [
        {
          messageId: asMessageId("message-queued-1"),
          threadId: ThreadId.make("thread-1"),
          text: "queued from projection",
          attachments: [],
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          titleSeed: "Queued title",
          runtimeMode: "full-access",
          interactionMode: "default",
          sourceProposedPlan: {
            threadId: ThreadId.make("thread-1"),
            planId: "plan-1",
          },
          createdAt: "2026-02-24T00:00:05.600Z",
          updatedAt: "2026-02-24T00:00:05.600Z",
        },
      ]);
    }),
  );

  it.effect("keeps archived threads out of the main shell snapshot", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const backgroundLiveness = yield* ThreadBackgroundLiveness.ThreadBackgroundLivenessService;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_provider_usage_limits`;
      yield* sql`DELETE FROM projection_state`;

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
        )
        VALUES (
          'project-archive-test',
          'Archive Test',
          '/tmp/archive-test',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-06T00:00:00.000Z',
          '2026-04-06T00:00:01.000Z',
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
          workspace_id,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-active',
            'project-archive-test',
            'Active Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            'workspace-active',
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T00:00:02.000Z',
            '2026-04-06T00:00:03.000Z',
            NULL,
            NULL
          ),
          (
            'thread-archived',
            'project-archive-test',
            'Archived Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            'workspace-archived',
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T00:00:04.000Z',
            '2026-04-06T00:00:05.000Z',
            '2026-04-06T00:00:06.000Z',
            NULL
          )
      `;

      // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed persisted test fixture.
      const usageLimitsJson = JSON.stringify({
        limitId: "codex",
        limitName: "Codex",
        planType: "pro",
        rateLimitReachedType: null,
        credits: null,
        primary: null,
        secondary: null,
        updatedAt: "2026-04-06T00:00:08.000Z",
      });
      yield* sql`
        INSERT INTO projection_provider_usage_limits (
          provider_instance_id,
          provider,
          usage_limits_json,
          updated_at
        ) VALUES (
          'codex',
          'codex',
          ${usageLimitsJson},
          '2026-04-06T00:00:08.000Z'
        )
      `;

      backgroundLiveness.recordTaskLiveness({
        threadId: "thread-active",
        taskId: "agent-active",
        taskType: "agent",
        status: "running",
        kind: "started",
      });
      backgroundLiveness.recordTaskLiveness({
        threadId: "thread-archived",
        taskId: "agent-archived",
        taskType: "agent",
        status: "running",
        kind: "started",
      });

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          (${ORCHESTRATION_PROJECTOR_NAMES.projects}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadQueuedMessages}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, 4, '2026-04-06T00:00:07.000Z')
      `;

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.deepEqual(
        shellSnapshot.threads.map((thread) => thread.id),
        [ThreadId.make("thread-active")],
      );
      assert.equal(shellSnapshot.threads[0]?.workspaceId, "workspace-active");
      assert.equal(shellSnapshot.threads[0]?.backgroundLiveness, "working");
      assert.equal(shellSnapshot.usageLimits[0]?.providerInstanceId, "codex");

      const activeThreadShell = yield* snapshotQuery.getThreadShellById(
        ThreadId.make("thread-active"),
      );
      assert.equal(Option.getOrUndefined(activeThreadShell)?.workspaceId, "workspace-active");
      assert.equal(Option.getOrUndefined(activeThreadShell)?.backgroundLiveness, "working");

      const archivedShellSnapshot = yield* snapshotQuery.getArchivedShellSnapshot();
      assert.deepEqual(
        archivedShellSnapshot.threads.map((thread) => thread.id),
        [ThreadId.make("thread-archived")],
      );
      assert.equal(archivedShellSnapshot.threads[0]?.archivedAt, "2026-04-06T00:00:06.000Z");
      assert.equal(archivedShellSnapshot.threads[0]?.workspaceId, "workspace-archived");
      assert.equal(archivedShellSnapshot.threads[0]?.backgroundLiveness, "working");
      assert.equal(archivedShellSnapshot.usageLimits[0]?.providerInstanceId, "codex");
    }),
  );

  it.effect("keeps settled threads in the shell snapshot with non-null settlement fields", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_state`;

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
        )
        VALUES (
          'project-settled-test',
          'Settled Test',
          '/tmp/settled-test',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-06T00:00:00.000Z',
          '2026-04-06T00:00:01.000Z',
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
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          deleted_at
        )
        VALUES (
          'thread-settled',
          'project-settled-test',
          'Settled Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          0,
          0,
          '2026-04-06T00:00:02.000Z',
          '2026-04-06T00:00:05.000Z',
          NULL,
          'settled',
          '2026-04-06T00:00:04.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          (${ORCHESTRATION_PROJECTOR_NAMES.projects}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, 4, '2026-04-06T00:00:07.000Z')
      `;

      // Settled ≠ archived: the thread must appear in the LIVE shell
      // snapshot, carrying its settlement fields through the row aliases.
      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.deepEqual(
        shellSnapshot.threads.map((thread) => thread.id),
        [ThreadId.make("thread-settled")],
      );
      assert.equal(shellSnapshot.threads[0]?.settledOverride, "settled");
      assert.equal(shellSnapshot.threads[0]?.settledAt, "2026-04-06T00:00:04.000Z");

      // And the full command read model carries them too.
      const readModel = yield* snapshotQuery.getCommandReadModel();
      const thread = readModel.threads.find(
        (candidate) => candidate.id === ThreadId.make("thread-settled"),
      );
      assert.equal(thread?.settledOverride, "settled");
      assert.equal(thread?.settledAt, "2026-04-06T00:00:04.000Z");
    }),
  );

  it.effect(
    "reads targeted project, thread, and count queries without hydrating the full snapshot",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_projects`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_turns`;

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
        )
        VALUES
          (
            'project-active',
            'Active Project',
            '/tmp/workspace',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:01.000Z',
            NULL
          ),
          (
            'project-deleted',
            'Deleted Project',
            '/tmp/deleted',
            NULL,
            '[]',
            '2026-03-01T00:00:02.000Z',
            '2026-03-01T00:00:03.000Z',
            '2026-03-01T00:00:04.000Z'
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
          deleted_at
        )
        VALUES
          (
            'thread-first',
            'project-active',
            'First Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:05.000Z',
            '2026-03-01T00:00:06.000Z',
            NULL,
            NULL
          ),
          (
            'thread-second',
            'project-active',
            'Second Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:07.000Z',
            '2026-03-01T00:00:08.000Z',
            NULL,
            NULL
          ),
          (
            'thread-deleted',
            'project-active',
            'Deleted Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:09.000Z',
            '2026-03-01T00:00:10.000Z',
            NULL,
            '2026-03-01T00:00:11.000Z'
          )
      `;

        const counts = yield* snapshotQuery.getCounts();
        assert.deepEqual(counts, {
          projectCount: 2,
          threadCount: 3,
        });

        const project = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/workspace");
        assert.equal(project._tag, "Some");
        if (project._tag === "Some") {
          assert.equal(project.value.id, asProjectId("project-active"));
        }

        const missingProject = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/missing");
        assert.equal(missingProject._tag, "None");

        const firstThreadId = yield* snapshotQuery.getFirstActiveThreadIdByProjectId(
          asProjectId("project-active"),
        );
        assert.equal(firstThreadId._tag, "Some");
        if (firstThreadId._tag === "Some") {
          assert.equal(firstThreadId.value, ThreadId.make("thread-first"));
        }
      }),
  );

  it.effect("reads compact thread result context without hydrating full thread bodies", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_queued_messages`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;

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
        )
        VALUES (
          'project-result',
          'Result Project',
          '/tmp/result-project',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-07-08T00:00:00.000Z',
          '2026-07-08T00:00:01.000Z',
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
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-result',
          'project-result',
          'Result Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          '2026-07-08T00:00:06.000Z',
          0,
          0,
          0,
          '2026-07-08T00:00:02.000Z',
          '2026-07-08T00:00:03.000Z',
          NULL,
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
        )
        VALUES
          (
            'message-user-old',
            'thread-result',
            NULL,
            'user',
            'older user message',
            NULL,
            0,
            '2026-07-08T00:00:04.000Z',
            '2026-07-08T00:00:04.000Z'
          ),
          (
            'message-assistant-old',
            'thread-result',
            NULL,
            'assistant',
            'older assistant message',
            NULL,
            0,
            '2026-07-08T00:00:05.000Z',
            '2026-07-08T00:00:05.000Z'
          ),
          (
            'message-assistant-new',
            'thread-result',
            NULL,
            'assistant',
            'newer assistant message',
            NULL,
            0,
            '2026-07-08T00:00:06.000Z',
            '2026-07-08T00:00:06.000Z'
          ),
          (
            'message-user-new',
            'thread-result',
            NULL,
            'user',
            'newest user message',
            NULL,
            0,
            '2026-07-08T00:00:07.000Z',
            '2026-07-08T00:00:07.000Z'
          )
      `;

      yield* sql`
        INSERT INTO projection_thread_queued_messages (
          message_id,
          thread_id,
          text,
          attachments_json,
          model_selection_json,
          title_seed,
          runtime_mode,
          interaction_mode,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          created_at,
          updated_at
        )
        VALUES
          (
            'queued-1',
            'thread-result',
            'first queued message',
            '[]',
            NULL,
            NULL,
            'full-access',
            'default',
            NULL,
            NULL,
            '2026-07-08T00:00:08.000Z',
            '2026-07-08T00:00:08.000Z'
          ),
          (
            'queued-2',
            'thread-result',
            'second queued message',
            '[]',
            NULL,
            NULL,
            'full-access',
            'default',
            NULL,
            NULL,
            '2026-07-08T00:00:09.000Z',
            '2026-07-08T00:00:09.000Z'
          )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at
        )
        VALUES
          (
            'activity-result-1',
            'thread-result',
            NULL,
            'info',
            'runtime.note',
            'first activity',
            '{}',
            '2026-07-08T00:00:10.000Z'
          ),
          (
            'activity-result-2',
            'thread-result',
            NULL,
            'info',
            'runtime.note',
            'second activity',
            '{}',
            '2026-07-08T00:00:11.000Z'
          ),
          (
            'activity-result-3',
            'thread-result',
            NULL,
            'info',
            'runtime.note',
            'third activity',
            '{}',
            '2026-07-08T00:00:12.000Z'
          )
      `;

      const contextOption = yield* snapshotQuery.getThreadResultContextById(
        ThreadId.make("thread-result"),
      );
      assert.equal(Option.isSome(contextOption), true);
      if (Option.isNone(contextOption)) return;

      const context = contextOption.value;
      assert.equal(context.thread.id, ThreadId.make("thread-result"));
      assert.equal(context.project.id, ProjectId.make("project-result"));
      assert.equal(context.latestMessage?.id, MessageId.make("message-user-new"));
      assert.equal(context.latestMessage?.text, "newest user message");
      assert.equal(context.latestAssistantMessage?.id, MessageId.make("message-assistant-new"));
      assert.equal(context.latestAssistantMessage?.text, "newer assistant message");
      assert.equal(context.queuedMessageCount, 2);
      assert.equal(context.activityCount, 3);
    }),
  );

  it.effect("reads single-thread checkpoint context without hydrating unrelated threads", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;

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
        )
        VALUES (
          'project-context',
          'Context Project',
          '/tmp/context-workspace',
          NULL,
          '[]',
          '2026-03-02T00:00:00.000Z',
          '2026-03-02T00:00:01.000Z',
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
          deleted_at
        )
        VALUES (
          'thread-context',
          'project-context',
          'Context Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          'feature/perf',
          '/tmp/context-worktree',
          NULL,
          '2026-03-02T00:00:02.000Z',
          '2026-03-02T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-context',
            'turn-1',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            1,
            'checkpoint-a',
            'ready',
            '[]'
          ),
          (
            'thread-context',
            'turn-2',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            2,
            'checkpoint-b',
            'ready',
            '[]'
          )
      `;

      const context = yield* snapshotQuery.getThreadCheckpointContext(
        ThreadId.make("thread-context"),
      );
      assert.equal(context._tag, "Some");
      if (context._tag === "Some") {
        assert.deepEqual(context.value, {
          threadId: ThreadId.make("thread-context"),
          projectId: asProjectId("project-context"),
          workspaceRoot: "/tmp/context-workspace",
          workspaceId: null,
          worktreePath: "/tmp/context-worktree",
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-a"),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: "2026-03-02T00:00:04.000Z",
            },
            {
              turnId: asTurnId("turn-2"),
              checkpointTurnCount: 2,
              checkpointRef: asCheckpointRef("checkpoint-b"),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: "2026-03-02T00:00:05.000Z",
            },
          ],
        });
      }
    }),
  );

  it.effect("keeps thread detail activity ordering consistent with shell snapshot ordering", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_state`;

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
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-01T00:00:00.000Z',
          '2026-04-01T00:00:01.000Z',
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
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          0,
          0,
          '2026-04-01T00:00:02.000Z',
          '2026-04-01T00:00:03.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'activity-unsequenced',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'unsequenced first',
            '{"source":"unsequenced"}',
            NULL,
            '2026-04-01T00:00:06.000Z'
          ),
          (
            'activity-sequence-2',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'sequence two',
            '{"source":"sequence-2"}',
            2,
            '2026-04-01T00:00:04.000Z'
          ),
          (
            'activity-sequence-1',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'sequence one',
            '{"source":"sequence-1"}',
            1,
            '2026-04-01T00:00:05.000Z'
          )
      `;

      const snapshot = yield* snapshotQuery.getSnapshot();
      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));

      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.deepEqual(threadDetail.value.activities, snapshot.threads[0]?.activities ?? []);
      }

      assert.deepEqual(snapshot.threads[0]?.activities ?? [], [
        {
          id: asEventId("activity-sequence-1"),
          tone: "info",
          kind: "runtime.note",
          summary: "sequence one",
          payload: { source: "sequence-1" },
          turnId: null,
          sequence: 1,
          createdAt: "2026-04-01T00:00:05.000Z",
        },
        {
          id: asEventId("activity-sequence-2"),
          tone: "info",
          kind: "runtime.note",
          summary: "sequence two",
          payload: { source: "sequence-2" },
          turnId: null,
          sequence: 2,
          createdAt: "2026-04-01T00:00:04.000Z",
        },
        {
          id: asEventId("activity-unsequenced"),
          tone: "info",
          kind: "runtime.note",
          summary: "unsequenced first",
          payload: { source: "unsequenced" },
          turnId: null,
          createdAt: "2026-04-01T00:00:06.000Z",
        },
      ]);
    }),
  );

  it.effect(
    "keeps only hot activity payloads in base snapshots and reads historical turns losslessly",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_thread_activities`;
        yield* sql`DELETE FROM projection_turns`;
        yield* sql`DELETE FROM projection_thread_sessions`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_projects`;
        yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json, scripts_json,
          created_at, updated_at, deleted_at
        ) VALUES (
          'project-activity-hydration', 'Activity hydration', '/tmp/activity-hydration',
          '{"provider":"codex","model":"gpt-5-codex"}', '[]',
          '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z', NULL
        )
      `;
        yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          branch, worktree_path, latest_turn_id, latest_user_message_at,
          pending_approval_count, pending_user_input_count, has_actionable_proposed_plan,
          created_at, updated_at, deleted_at
        ) VALUES (
          'thread-activity-hydration', 'project-activity-hydration', 'Activity hydration',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          NULL, NULL, 'turn-latest', NULL, 0, 0, 0,
          '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:04.000Z', NULL
        )
      `;
        yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, started_at, completed_at,
          checkpoint_files_json
        ) VALUES
          ('thread-activity-hydration', 'turn-historical', 'completed',
            '2026-07-17T00:00:01.000Z', '2026-07-17T00:00:01.000Z',
            '2026-07-17T00:00:01.500Z', '[]'),
          ('thread-activity-hydration', 'turn-active', 'running',
            '2026-07-17T00:00:02.000Z', '2026-07-17T00:00:02.000Z', NULL, '[]'),
          ('thread-activity-hydration', 'turn-latest', 'completed',
            '2026-07-17T00:00:03.000Z', '2026-07-17T00:00:03.000Z',
            '2026-07-17T00:00:03.500Z', '[]')
      `;
        yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, active_turn_id, last_error, updated_at,
          runtime_mode, provider_instance_id
        ) VALUES (
          'thread-activity-hydration', 'running', 'codex', 'turn-active', NULL,
          '2026-07-17T00:00:04.000Z', 'full-access', 'codex'
        )
      `;
        yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES
          ('activity-global', 'thread-activity-hydration', NULL, 'info', 'runtime.note',
            'global', '{"detail":"global-full"}', 1, '2026-07-17T00:00:00.500Z'),
          ('activity-historical-started', 'thread-activity-hydration', 'turn-historical', 'tool',
            'tool.started', 'historical started', '{"detail":"starting"}', 1,
            '2026-07-17T00:00:01.050Z'),
          ('activity-historical-1', 'thread-activity-hydration', 'turn-historical', 'tool',
            'tool.completed', 'historical one', '{"detail":"historical-full-1"}', 2,
            '2026-07-17T00:00:01.100Z'),
          ('activity-historical-2', 'thread-activity-hydration', 'turn-historical', 'tool',
            'tool.completed', 'historical two', '{"detail":"historical-full-2"}', 3,
            '2026-07-17T00:00:01.200Z'),
          ('activity-historical-plan-boundary', 'thread-activity-hydration', 'turn-historical',
            'tool', 'tool.completed', 'Exited plan mode', '{"detail":"ExitPlanMode: done"}', NULL,
            '2026-07-17T00:00:01.250Z'),
          ('activity-historical-plan', 'thread-activity-hydration', 'turn-historical', 'info',
            'turn.plan.updated', 'Updated plan',
            '{"plan":[{"step":"Verify production semantics","status":"completed"}]}', NULL,
            '2026-07-17T00:00:01.300Z'),
          ('activity-historical-subagent', 'thread-activity-hydration', 'turn-historical', 'tool',
            'subagent.thread', 'Reviewer completed',
            '{"providerThreadId":"provider-reviewer","task":"Review the fix","status":"completed"}',
            NULL, '2026-07-17T00:00:01.400Z'),
          ('activity-active', 'thread-activity-hydration', 'turn-active', 'tool',
            'tool.completed', 'active', '{"detail":"active-full"}', 4,
            '2026-07-17T00:00:02.100Z'),
          ('activity-latest', 'thread-activity-hydration', 'turn-latest', 'tool',
            'tool.completed', 'latest', '{"detail":"latest-full"}', 5,
            '2026-07-17T00:00:03.100Z'),
          ('activity-context-old', 'thread-activity-hydration', NULL, 'info',
            'context-window.updated', 'context old', '{"usedTokens":100}', 6,
            '2026-07-17T00:00:04.100Z'),
          ('activity-context-latest', 'thread-activity-hydration', NULL, 'info',
            'context-window.updated', 'context latest', '{"usedTokens":200}', 7,
            '2026-07-17T00:00:04.200Z'),
          ('activity-rate-old', 'thread-activity-hydration', NULL, 'info',
            'account.rate-limits.updated', 'rate old', '{"usedPercent":10}', 8,
            '2026-07-17T00:00:04.300Z'),
          ('activity-rate-latest', 'thread-activity-hydration', NULL, 'info',
            'account.rate-limits.updated', 'rate latest', '{"usedPercent":20}', 9,
            '2026-07-17T00:00:04.400Z')
      `;
        yield* sql`
          UPDATE projection_thread_activities
          SET
            activity_revision = CASE activity_id
            WHEN 'activity-historical-started' THEN 9
            WHEN 'activity-historical-1' THEN 10
            WHEN 'activity-historical-2' THEN 11
            WHEN 'activity-historical-plan' THEN 12
            WHEN 'activity-historical-subagent' THEN 13
            WHEN 'activity-historical-plan-boundary' THEN 14
            ELSE sequence
            END,
            payload_bytes = length(CAST(payload_json AS BLOB)),
            display_activity = CASE
              WHEN kind IN (
                'tool.started', 'task.started', 'context-window.updated',
                'account.rate-limits.updated', 'subagent.thread', 'turn.plan.updated'
              ) OR summary = 'Checkpoint captured' OR (
                kind IN ('tool.updated', 'tool.completed')
                AND json_extract(payload_json, '$.detail') LIKE 'ExitPlanMode:%'
              ) THEN 0 ELSE 1
            END
          WHERE thread_id = 'thread-activity-hydration'
        `;

        const fullDetail = yield* snapshotQuery.getThreadDetailById(
          ThreadId.make("thread-activity-hydration"),
        );
        assert.equal(fullDetail._tag, "Some");
        if (Option.isSome(fullDetail)) {
          assert.equal(fullDetail.value.activities.length, 13);
          assert.deepStrictEqual(fullDetail.value.historicalActivityGroups, []);
          assert.ok(
            fullDetail.value.activities.some(
              (activity) => activity.id === asEventId("activity-context-old"),
            ),
          );
        }

        const compactDetail = yield* snapshotQuery.getThreadDetailSnapshot(
          ThreadId.make("thread-activity-hydration"),
          "compact",
        );
        assert.equal(compactDetail._tag, "Some");
        if (Option.isSome(compactDetail)) {
          assert.equal(compactDetail.value.activityDetailMode, "compact");
          const detail = compactDetail.value.thread;
          assert.deepStrictEqual(
            detail.activities.map((activity) => [activity.id, activity.payload]),
            [
              [asEventId("activity-global"), { detail: "global-full" }],
              [asEventId("activity-active"), { detail: "active-full" }],
              [asEventId("activity-latest"), { detail: "latest-full" }],
              [asEventId("activity-context-latest"), { usedTokens: 200 }],
              [asEventId("activity-rate-old"), { usedPercent: 10 }],
              [asEventId("activity-rate-latest"), { usedPercent: 20 }],
              [
                asEventId("activity-historical-plan"),
                { plan: [{ step: "Verify production semantics", status: "completed" }] },
              ],
              [
                asEventId("activity-historical-subagent"),
                {
                  providerThreadId: "provider-reviewer",
                  task: "Review the fix",
                  status: "completed",
                },
              ],
            ],
          );
          assert.deepStrictEqual(detail.historicalActivityGroups, [
            {
              turnId: asTurnId("turn-historical"),
              revision: 14,
              activityCount: 4,
              payloadBytes: 112,
              displayActivityCount: 2,
              firstActivityAt: "2026-07-17T00:00:01.100Z",
              lastActivityAt: "2026-07-17T00:00:01.200Z",
            },
          ]);
        }

        const historical = yield* snapshotQuery.getTurnActivitiesSnapshot(
          ThreadId.make("thread-activity-hydration"),
          TurnId.make("turn-historical"),
        );
        assert.equal(historical._tag, "Some");
        if (Option.isSome(historical)) {
          assert.equal(historical.value.revision, 14);
          assert.equal(historical.value.payloadBytes, 112);
          assert.deepStrictEqual(
            historical.value.activities.map((activity) => [activity.id, activity.payload]),
            [
              [asEventId("activity-historical-started"), { detail: "starting" }],
              [asEventId("activity-historical-1"), { detail: "historical-full-1" }],
              [asEventId("activity-historical-2"), { detail: "historical-full-2" }],
              [asEventId("activity-historical-plan-boundary"), { detail: "ExitPlanMode: done" }],
            ],
          );
        }

        // Same-id unsequenced updates must invalidate a hydrated turn even
        // though provider ordering metadata and activity count are unchanged.
        yield* sql`
          UPDATE projection_thread_activities
          SET payload_json = '{"detail":"ExitPlanMode: café 🚀"}',
              payload_bytes = length(CAST('{"detail":"ExitPlanMode: café 🚀"}' AS BLOB)),
              activity_revision = 42
          WHERE activity_id = 'activity-historical-plan-boundary'
        `;
        const revisedCompact = yield* snapshotQuery.getThreadDetailSnapshot(
          ThreadId.make("thread-activity-hydration"),
          "compact",
        );
        assert.equal(revisedCompact._tag, "Some");
        if (Option.isSome(revisedCompact)) {
          assert.equal(revisedCompact.value.thread.historicalActivityGroups?.[0]?.revision, 42);
        }
        const revisedHistorical = yield* snapshotQuery.getTurnActivitiesSnapshot(
          ThreadId.make("thread-activity-hydration"),
          TurnId.make("turn-historical"),
        );
        assert.equal(revisedHistorical._tag, "Some");
        if (Option.isSome(revisedHistorical)) {
          assert.equal(revisedHistorical.value.revision, 42);
          assert.deepStrictEqual(revisedHistorical.value.activities[3]?.payload, {
            detail: "ExitPlanMode: café 🚀",
          });
          assert.equal(
            revisedHistorical.value.payloadBytes,
            revisedHistorical.value.activities.reduce(
              (bytes, activity) =>
                bytes + new TextEncoder().encode(JSON.stringify(activity.payload)).byteLength,
              0,
            ),
          );
        }

        const missing = yield* snapshotQuery.getTurnActivitiesSnapshot(
          ThreadId.make("thread-activity-hydration"),
          TurnId.make("turn-missing"),
        );
        assert.equal(missing._tag, "None");
      }),
  );

  it.effect("uses projection_threads.latest_turn_id for targeted thread latest turn queries", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;

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
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-02T00:00:00.000Z',
          '2026-04-02T00:00:01.000Z',
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
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-running',
          '2026-04-02T00:00:04.000Z',
          0,
          0,
          0,
          '2026-04-02T00:00:02.000Z',
          '2026-04-02T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-1',
            'turn-completed',
            'message-user-1',
            NULL,
            NULL,
            'message-assistant-1',
            'completed',
            '2026-04-02T00:00:05.000Z',
            '2026-04-02T00:00:06.000Z',
            '2026-04-02T00:00:20.000Z',
            5,
            'checkpoint-5',
            'ready',
            '[]'
          ),
          (
            'thread-1',
            'turn-running',
            'message-user-2',
            NULL,
            NULL,
            NULL,
            'running',
            '2026-04-02T00:00:30.000Z',
            '2026-04-02T00:00:30.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

      const threadShell = yield* snapshotQuery.getThreadShellById(ThreadId.make("thread-1"));
      assert.equal(threadShell._tag, "Some");
      if (threadShell._tag === "Some") {
        assert.equal(threadShell.value.latestTurn?.turnId, asTurnId("turn-running"));
        assert.equal(threadShell.value.latestTurn?.state, "running");
        assert.equal(threadShell.value.latestTurn?.startedAt, "2026-04-02T00:00:30.000Z");
      }

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.equal(threadDetail.value.latestTurn?.turnId, asTurnId("turn-running"));
        assert.equal(threadDetail.value.latestTurn?.state, "running");
        assert.equal(threadDetail.value.latestTurn?.startedAt, "2026-04-02T00:00:30.000Z");
      }
    }),
  );

  it.effect("uses projection_threads.latest_turn_id for bulk command and shell snapshots", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

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
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-03T00:00:00.000Z',
          '2026-04-03T00:00:01.000Z',
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
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-running',
          '2026-04-03T00:00:04.000Z',
          0,
          0,
          0,
          '2026-04-03T00:00:02.000Z',
          '2026-04-03T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-1',
            'turn-running',
            'message-user-2',
            NULL,
            NULL,
            NULL,
            'running',
            '2026-04-03T00:00:30.000Z',
            '2026-04-03T00:00:30.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-1',
            'turn-completed',
            'message-user-1',
            NULL,
            NULL,
            'message-assistant-1',
            'completed',
            '2026-04-03T00:00:05.000Z',
            '2026-04-03T00:00:06.000Z',
            '2026-04-03T00:00:20.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          (${ORCHESTRATION_PROJECTOR_NAMES.projects}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadQueuedMessages}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, 3, '2026-04-03T00:00:40.000Z')
      `;

      const commandReadModel = yield* snapshotQuery.getCommandReadModel();
      assert.equal(commandReadModel.threads[0]?.latestTurn?.turnId, asTurnId("turn-running"));
      assert.equal(commandReadModel.threads[0]?.latestTurn?.state, "running");

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.threads[0]?.latestTurn?.turnId, asTurnId("turn-running"));
      assert.equal(shellSnapshot.threads[0]?.latestTurn?.state, "running");

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.turnId, asTurnId("turn-running"));
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.state, "running");
    }),
  );

  it.effect("keeps deleted project and thread tombstones in the command read model", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

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
        )
        VALUES (
          'project-deleted',
          'Deleted Project',
          '/tmp/deleted-project',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-05T00:00:00.000Z',
          '2026-04-05T00:00:01.000Z',
          '2026-04-05T00:00:02.000Z'
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
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-deleted',
          'project-deleted',
          'Deleted Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-deleted',
          NULL,
          0,
          0,
          0,
          '2026-04-05T00:00:03.000Z',
          '2026-04-05T00:00:04.000Z',
          NULL,
          '2026-04-05T00:00:05.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-deleted',
          'turn-deleted',
          'message-deleted-user',
          NULL,
          NULL,
          'message-deleted-assistant',
          'completed',
          '2026-04-05T00:00:04.100Z',
          '2026-04-05T00:00:04.200Z',
          '2026-04-05T00:00:04.300Z',
          NULL,
          NULL,
          NULL,
          '[]'
        )
      `;

      const commandReadModel = yield* snapshotQuery.getCommandReadModel();
      assert.equal(commandReadModel.projects[0]?.id, asProjectId("project-deleted"));
      assert.equal(commandReadModel.projects[0]?.deletedAt, "2026-04-05T00:00:02.000Z");
      assert.equal(commandReadModel.threads[0]?.id, ThreadId.make("thread-deleted"));
      assert.equal(commandReadModel.threads[0]?.deletedAt, "2026-04-05T00:00:05.000Z");
      assert.equal(commandReadModel.threads[0]?.latestTurn?.turnId, asTurnId("turn-deleted"));
      assert.equal(commandReadModel.threads[0]?.latestTurn?.state, "completed");

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      assert.equal(fullSnapshot.threads[0]?.id, ThreadId.make("thread-deleted"));
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.turnId, asTurnId("turn-deleted"));
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.state, "completed");

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.projects.length, 0);
      assert.equal(shellSnapshot.threads.length, 0);
    }),
  );

  it.effect("searches active user messages and canonical assistant outputs", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;

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
        )
        VALUES (
          'project-search',
          'Project Needle',
          '/tmp/project-search',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-05-01T00:00:00.000Z',
          '2026-05-01T00:00:01.000Z',
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
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-active',
            'project-search',
            'Literal 100% fix',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            'search-branch',
            NULL,
            'turn-active',
            '2026-05-01T00:00:02.000Z',
            0,
            0,
            0,
            '2026-05-01T00:00:02.000Z',
            '2026-05-01T00:00:03.000Z',
            NULL,
            NULL
          ),
          (
            'thread-percent-decoy',
            'project-search',
            'Literal 100x fix',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-05-01T00:00:04.000Z',
            '2026-05-01T00:00:05.000Z',
            NULL,
            NULL
          ),
          (
            'thread-hidden',
            'project-search',
            'Archived search',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-05-01T00:00:06.000Z',
            '2026-05-01T00:00:07.000Z',
            '2026-05-01T00:00:08.000Z',
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
          is_streaming,
          created_at,
          updated_at
        )
        VALUES
          (
            'message-user',
            'thread-active',
            'turn-active',
            'user',
            'Please find this USER needle in an old prompt.',
            0,
            '2026-05-01T00:00:12.000Z',
            '2026-05-01T00:00:12.000Z'
          ),
          (
            'message-percent',
            'thread-active',
            NULL,
            'user',
            'Literal 100% fix in a prompt.',
            0,
            '2026-05-01T00:00:11.000Z',
            '2026-05-01T00:00:11.000Z'
          ),
          (
            'message-percent-decoy',
            'thread-percent-decoy',
            NULL,
            'user',
            'Literal 100x fix in a prompt.',
            0,
            '2026-05-01T00:00:11.000Z',
            '2026-05-01T00:00:11.000Z'
          ),
          (
            'message-final',
            'thread-active',
            'turn-active',
            'assistant',
            'The canonical final needle appears in this completed answer.',
            0,
            '2026-05-01T00:00:13.000Z',
            '2026-05-01T00:00:13.000Z'
          ),
          (
            'message-interim',
            'thread-active',
            'turn-active',
            'assistant',
            'Interim needle must not be searchable.',
            0,
            '2026-05-01T00:00:14.000Z',
            '2026-05-01T00:00:14.000Z'
          ),
          (
            'message-system',
            'thread-active',
            NULL,
            'system',
            'System needle must not be searchable.',
            0,
            '2026-05-01T00:00:15.000Z',
            '2026-05-01T00:00:15.000Z'
          ),
          (
            'message-hidden',
            'thread-hidden',
            NULL,
            'user',
            'Hidden needle in archive.',
            0,
            '2026-05-01T00:00:16.000Z',
            '2026-05-01T00:00:16.000Z'
          )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_files_json
        )
        VALUES (
          'thread-active',
          'turn-active',
          'message-user',
          'message-final',
          'completed',
          '2026-05-01T00:00:12.000Z',
          '2026-05-01T00:00:12.000Z',
          '2026-05-01T00:00:13.000Z',
          '[]'
        )
      `;

      const literalPercent = yield* snapshotQuery.searchThreads({ query: "100%" });
      assert.deepStrictEqual(
        literalPercent.matches.map((match) => [match.threadId, match.source]),
        [[ThreadId.make("thread-active"), "user"]],
      );

      const user = yield* snapshotQuery.searchThreads({ query: "user needle" });
      assert.equal(user.matches[0]?.source, "user");
      assert.match(user.matches[0]?.snippet ?? "", /USER needle/);

      const assistant = yield* snapshotQuery.searchThreads({ query: "FINAL NEEDLE" });
      assert.equal(assistant.matches[0]?.source, "assistant");

      const deduped = yield* snapshotQuery.searchThreads({ query: "needle" });
      assert.deepStrictEqual(
        deduped.matches.map((match) => [match.threadId, match.source]),
        [[ThreadId.make("thread-active"), "user"]],
      );

      assert.deepStrictEqual(
        (yield* snapshotQuery.searchThreads({ query: "interim needle" })).matches,
        [],
      );
      assert.deepStrictEqual(
        (yield* snapshotQuery.searchThreads({ query: "system needle" })).matches,
        [],
      );
      assert.deepStrictEqual(
        (yield* snapshotQuery.searchThreads({ query: "hidden needle" })).matches,
        [],
      );
      yield* sql`
        UPDATE projection_threads
        SET deleted_at = '2026-05-01T00:00:20.000Z'
        WHERE thread_id = 'thread-active'
      `;
      assert.deepStrictEqual(
        (yield* snapshotQuery.searchThreads({ query: "user needle" })).matches,
        [],
      );
    }),
  );
});

it.effect(
  "ProjectionSnapshotQuery dedupes repository identity resolution by workspace root and skips deleted projects for shell snapshots",
  () => {
    const resolveCalls: string[] = [];
    const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provideMerge(
        Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
          resolve: (cwd: string) =>
            Effect.sync(() => {
              resolveCalls.push(cwd);
              return {
                canonicalKey: `github.com/acme${cwd}`,
                locator: {
                  source: "git-remote" as const,
                  remoteName: "origin",
                  remoteUrl: `https://github.com/acme${cwd}.git`,
                },
                rootPath: cwd,
              };
            }),
        }),
      ),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    return Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

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
        )
        VALUES
          (
            'project-1',
            'Shared Project 1',
            '/tmp/shared-root',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-04-04T00:00:00.000Z',
            '2026-04-04T00:00:01.000Z',
            NULL
          ),
          (
            'project-2',
            'Shared Project 2',
            '/tmp/shared-root',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-04-04T00:00:02.000Z',
            '2026-04-04T00:00:03.000Z',
            NULL
          ),
          (
            'project-3',
            'Deleted Project',
            '/tmp/deleted-root',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-04-04T00:00:04.000Z',
            '2026-04-04T00:00:05.000Z',
            '2026-04-04T00:00:06.000Z'
          )
      `;

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.deepStrictEqual(resolveCalls.toSorted(), ["/tmp/shared-root"]);
      assert.equal(shellSnapshot.projects.length, 2);
      assert.equal(shellSnapshot.projects[0]?.repositoryIdentity?.rootPath, "/tmp/shared-root");
      assert.equal(shellSnapshot.projects[1]?.repositoryIdentity?.rootPath, "/tmp/shared-root");

      resolveCalls.length = 0;

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      assert.deepStrictEqual(resolveCalls.toSorted(), ["/tmp/deleted-root", "/tmp/shared-root"]);
      assert.equal(fullSnapshot.projects.length, 3);
      assert.equal(fullSnapshot.projects[2]?.repositoryIdentity?.rootPath, "/tmp/deleted-root");
    }).pipe(Effect.provide(layer));
  },
);

projectionSnapshotLayer("ProjectionSnapshotQuery windowed thread detail", (it) => {
  // A thread shaped like real fan-out usage: user turns interleaved with
  // subagent turns (no user pending message), plus a turnless straggler user
  // message and a turnless activity anchored between turns.
  //
  //   row  turn      pending msg        anchor (requested_at)
  //   1    turn-1    user-msg-1         T00
  //   2    turn-2    (subagent)         T01
  //   3    turn-3    (subagent)         T02
  //   4    turn-4    user-msg-4         T03
  //   5    turn-5    user-msg-5         T04
  //
  // Straggler user message at T03.5 (turn_id NULL, not any pending_message_id)
  // and a turnless activity at T03.6 — both belong to the page containing T03+.
  const seedFanOutThread = Effect.fnUntraced(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Tests in this block share one in-memory database; reset before seeding.
    yield* sql`DELETE FROM projection_projects`;
    yield* sql`DELETE FROM projection_threads`;
    yield* sql`DELETE FROM projection_turns`;
    yield* sql`DELETE FROM projection_thread_messages`;
    yield* sql`DELETE FROM projection_thread_activities`;
    yield* sql`DELETE FROM projection_state`;

    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
      )
      VALUES ('project-w', 'Windowed', '/tmp/project-w', '[]',
        '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', NULL)
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        latest_turn_id, pending_approval_count, pending_user_input_count,
        has_actionable_proposed_plan, created_at, updated_at, deleted_at
      )
      VALUES ('thread-w', 'project-w', 'Windowed thread',
        '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
        'turn-5', 0, 0, 0, '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:10.000Z', NULL)
    `;

    const turns: ReadonlyArray<{
      turn: string;
      pendingMessage: string | null;
      at: string;
    }> = [
      { turn: "turn-1", pendingMessage: "user-msg-1", at: "2026-03-01T00:00:00.000Z" },
      { turn: "turn-2", pendingMessage: null, at: "2026-03-01T00:01:00.000Z" },
      { turn: "turn-3", pendingMessage: null, at: "2026-03-01T00:02:00.000Z" },
      { turn: "turn-4", pendingMessage: "user-msg-4", at: "2026-03-01T00:03:00.000Z" },
      { turn: "turn-5", pendingMessage: "user-msg-5", at: "2026-03-01T00:04:00.000Z" },
    ];
    for (const { turn, pendingMessage, at } of turns) {
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, state, requested_at, started_at, completed_at,
          checkpoint_files_json
        )
        VALUES ('thread-w', ${turn}, ${pendingMessage}, 'completed', ${at}, ${at}, ${at}, '[]')
      `;
      if (pendingMessage !== null) {
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
          )
          VALUES (${pendingMessage}, 'thread-w', NULL, 'user', ${"prompt for " + turn}, 0, ${at}, ${at})
        `;
      }
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        )
        VALUES (${turn + "-reply"}, 'thread-w', ${turn}, 'assistant', ${"reply from " + turn}, 0, ${at}, ${at})
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
        )
        VALUES (${turn + "-activity"}, 'thread-w', ${turn}, 'tool', 'tool.completed',
          'ran tool', '{"ok":true}', ${at})
      `;
    }

    // Straggler user message sent while turn-4 ran: turn_id NULL and not any
    // turn's pending_message_id.
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
      )
      VALUES ('user-msg-straggler', 'thread-w', NULL, 'user', 'while you are at it',
        0, '2026-03-01T00:03:30.000Z', '2026-03-01T00:03:30.000Z')
    `;
    // Turnless activity in the same time range.
    yield* sql`
      INSERT INTO projection_thread_activities (
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
      )
      VALUES ('turnless-activity', 'thread-w', NULL, 'info', 'context-window.updated',
        'usage', '{"usedTokens":1}', '2026-03-01T00:03:36.000Z')
    `;

    for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES (${projector}, 42, '2026-03-01T00:00:10.000Z')
      `;
    }
  });

  const threadW = ThreadId.make("thread-w");
  const messageIds = (snapshot: { thread: { messages: ReadonlyArray<{ id: string }> } }) =>
    snapshot.thread.messages.map((message) => message.id).toSorted();
  const activityIds = (snapshot: { thread: { activities: ReadonlyArray<{ id: string }> } }) =>
    snapshot.thread.activities.map((activity) => activity.id).toSorted();

  it.effect("returns the full thread with no page metadata when no window is requested", () =>
    Effect.gen(function* () {
      yield* seedFanOutThread();
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const snapshot = yield* snapshotQuery.getThreadDetailSnapshot(threadW);
      assert.equal(snapshot._tag, "Some");
      if (snapshot._tag === "Some") {
        assert.equal(snapshot.value.page, undefined);
        assert.equal(snapshot.value.thread.messages.length, 9);
        assert.equal(snapshot.value.thread.activities.length, 6);
        assert.equal(snapshot.value.snapshotSequence, 42);
      }
    }),
  );

  it.effect("windows to the last N user-anchored turns with subagent turns riding along", () =>
    Effect.gen(function* () {
      yield* seedFanOutThread();
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      // turnLimit 2 walks back: turn-5 (user), turn-4 (user) -> window is
      // rows 4..5. Subagent turns 2-3 are older than the 2nd user turn and
      // stay out; the straggler message and turnless activity (T03.5/T03.6,
      // after turn-4's anchor) ride along.
      const snapshot = yield* snapshotQuery.getThreadDetailSnapshot(threadW, { turnLimit: 2 });
      assert.equal(snapshot._tag, "Some");
      if (snapshot._tag === "Some") {
        assert.deepEqual(messageIds(snapshot.value), [
          "turn-4-reply",
          "turn-5-reply",
          "user-msg-4",
          "user-msg-5",
          "user-msg-straggler",
        ]);
        assert.deepEqual(activityIds(snapshot.value), [
          "turn-4-activity",
          "turn-5-activity",
          "turnless-activity",
        ]);
        assert.equal(snapshot.value.page?.hasMore, true);
        assert.notEqual(snapshot.value.page?.beforeCursor, null);
        assert.equal(snapshot.value.page?.snapshotSequence, 42);
      }
    }),
  );

  it.effect("subagent turns between user turns ride along inside the window", () =>
    Effect.gen(function* () {
      yield* seedFanOutThread();
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      // turnLimit 3 reaches user turn-1, dragging subagent turns 2-3 along:
      // the full thread, so no further pages.
      const snapshot = yield* snapshotQuery.getThreadDetailSnapshot(threadW, { turnLimit: 3 });
      assert.equal(snapshot._tag, "Some");
      if (snapshot._tag === "Some") {
        assert.equal(snapshot.value.thread.messages.length, 9);
        assert.equal(snapshot.value.thread.activities.length, 6);
        assert.equal(snapshot.value.page?.hasMore, false);
        assert.equal(snapshot.value.page?.beforeCursor, null);
      }
    }),
  );

  it.effect("cursors survive a projection rewrite that reassigns turn row ids", () =>
    Effect.gen(function* () {
      // The revert projector (and any projection rebuild) deletes and
      // re-upserts projection_turns, assigning fresh autoincrement row ids.
      // The keyset cursor is derived from event content, so a page cursor
      // minted before the rewrite must keep working after it.
      yield* seedFanOutThread();
      const sql = yield* SqlClient.SqlClient;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const firstPage = yield* snapshotQuery.getThreadDetailSnapshot(threadW, { turnLimit: 2 });
      assert.equal(firstPage._tag, "Some");
      if (firstPage._tag !== "Some") return;
      const cursor = firstPage.value.page?.beforeCursor;
      assert.notEqual(cursor, null);
      if (cursor === null || cursor === undefined) return;

      // Simulate the rewrite: delete and re-insert every turn row with the
      // same content, which reassigns all row ids.
      const turnRows = yield* sql`
        SELECT thread_id, turn_id, pending_message_id, state, requested_at, started_at,
          completed_at, checkpoint_files_json
        FROM projection_turns WHERE thread_id = 'thread-w' ORDER BY row_id
      `;
      yield* sql`DELETE FROM projection_turns WHERE thread_id = 'thread-w'`;
      for (const row of turnRows) {
        yield* sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, state, requested_at, started_at,
            completed_at, checkpoint_files_json
          )
          VALUES (${row.thread_id as string}, ${row.turn_id as string},
            ${row.pending_message_id as string | null}, ${row.state as string},
            ${row.requested_at as string}, ${row.started_at as string},
            ${row.completed_at as string}, ${row.checkpoint_files_json as string})
        `;
      }

      const olderPage = yield* snapshotQuery.getThreadDetailSnapshot(threadW, {
        turnLimit: 1,
        beforeCursor: cursor,
      });
      assert.equal(olderPage._tag, "Some");
      if (olderPage._tag === "Some") {
        // Identical older slice to what the pre-rewrite cursor would return.
        assert.deepEqual(messageIds(olderPage.value), [
          "turn-1-reply",
          "turn-2-reply",
          "turn-3-reply",
          "user-msg-1",
        ]);
        assert.equal(olderPage.value.page?.hasMore, false);
      }
    }),
  );

  it.effect("beforeCursor returns the disjoint adjacent older slice", () =>
    Effect.gen(function* () {
      yield* seedFanOutThread();
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const firstPage = yield* snapshotQuery.getThreadDetailSnapshot(threadW, { turnLimit: 2 });
      assert.equal(firstPage._tag, "Some");
      if (firstPage._tag !== "Some") return;
      const cursor = firstPage.value.page?.beforeCursor;
      assert.notEqual(cursor, null);
      assert.notEqual(cursor, undefined);
      if (cursor === null || cursor === undefined) return;

      // Older page: user turn-1 plus subagent turns 2-3 riding along. Disjoint
      // from the first page: no turn-4/5 rows, no straggler.
      const olderPage = yield* snapshotQuery.getThreadDetailSnapshot(threadW, {
        turnLimit: 1,
        beforeCursor: cursor,
      });
      assert.equal(olderPage._tag, "Some");
      if (olderPage._tag === "Some") {
        assert.deepEqual(messageIds(olderPage.value), [
          "turn-1-reply",
          "turn-2-reply",
          "turn-3-reply",
          "user-msg-1",
        ]);
        assert.deepEqual(activityIds(olderPage.value), [
          "turn-1-activity",
          "turn-2-activity",
          "turn-3-activity",
        ]);
        assert.equal(olderPage.value.page?.hasMore, false);
        assert.equal(olderPage.value.page?.beforeCursor, null);
      }
    }),
  );

  it.effect("a cursor for a different thread degrades to the first page", () =>
    Effect.gen(function* () {
      yield* seedFanOutThread();
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const firstPage = yield* snapshotQuery.getThreadDetailSnapshot(threadW, { turnLimit: 2 });
      assert.equal(firstPage._tag, "Some");
      if (firstPage._tag !== "Some") return;

      const foreign = encodeThreadDetailPageCursor({
        threadId: ThreadId.make("thread-other"),
        beforeAnchorAt: "2026-03-01T00:01:00.000Z",
        beforeTurnId: "turn-2",
      });
      const snapshot = yield* snapshotQuery.getThreadDetailSnapshot(threadW, {
        turnLimit: 2,
        beforeCursor: foreign,
      });
      assert.equal(snapshot._tag, "Some");
      if (snapshot._tag === "Some") {
        assert.deepEqual(messageIds(snapshot.value), messageIds(firstPage.value));
      }
    }),
  );

  it.effect("a malformed cursor degrades to the first page instead of failing", () =>
    Effect.gen(function* () {
      yield* seedFanOutThread();
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const snapshot = yield* snapshotQuery.getThreadDetailSnapshot(threadW, {
        turnLimit: 2,
        beforeCursor: "not-a-cursor",
      });
      assert.equal(snapshot._tag, "Some");
      if (snapshot._tag === "Some") {
        assert.equal(snapshot.value.page?.hasMore, true);
        assert.equal(snapshot.value.thread.messages.length, 5);
      }
    }),
  );

  it.effect("windows never split below the raw-turn ceiling boundary contiguously", () =>
    Effect.gen(function* () {
      yield* seedFanOutThread();
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      // Page repeatedly with turnLimit 1 and assert the union of all pages is
      // exactly the full thread with no duplicates (disjointness + coverage).
      const seenMessages: string[] = [];
      const seenActivities: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const snapshot = yield* snapshotQuery.getThreadDetailSnapshot(threadW, {
          turnLimit: 1,
          ...(cursor !== undefined ? { beforeCursor: cursor } : {}),
        });
        assert.equal(snapshot._tag, "Some");
        if (snapshot._tag !== "Some") return;
        seenMessages.push(...snapshot.value.thread.messages.map((message) => message.id));
        seenActivities.push(...snapshot.value.thread.activities.map((activity) => activity.id));
        const next = snapshot.value.page?.beforeCursor;
        if (next === null || next === undefined) break;
        cursor = next;
      }
      assert.equal(new Set(seenMessages).size, seenMessages.length);
      assert.equal(new Set(seenActivities).size, seenActivities.length);
      assert.equal(seenMessages.length, 9);
      assert.equal(seenActivities.length, 6);
    }),
  );

  it.effect("a thread with no turns returns its content unwindowed on the first page", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
        )
        VALUES ('project-e', 'Empty', '/tmp/project-e', '[]',
          '2026-03-02T00:00:00.000Z', '2026-03-02T00:00:00.000Z', NULL)
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          pending_approval_count, pending_user_input_count, has_actionable_proposed_plan,
          created_at, updated_at, deleted_at
        )
        VALUES ('thread-e', 'project-e', 'Turnless thread',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          0, 0, 0, '2026-03-02T00:00:00.000Z', '2026-03-02T00:00:00.000Z', NULL)
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        )
        VALUES ('pre-turn-msg', 'thread-e', NULL, 'user', 'first prompt', 0,
          '2026-03-02T00:00:01.000Z', '2026-03-02T00:00:01.000Z')
      `;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
          VALUES (${projector}, 7, '2026-03-02T00:00:01.000Z')
        `;
      }

      const snapshot = yield* snapshotQuery.getThreadDetailSnapshot(ThreadId.make("thread-e"), {
        turnLimit: 5,
      });
      assert.equal(snapshot._tag, "Some");
      if (snapshot._tag === "Some") {
        assert.deepEqual(messageIds(snapshot.value), ["pre-turn-msg"]);
        assert.equal(snapshot.value.page?.hasMore, false);
        assert.equal(snapshot.value.page?.beforeCursor, null);
      }
    }),
  );
});
