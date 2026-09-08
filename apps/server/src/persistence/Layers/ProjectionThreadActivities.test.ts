import { EventId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadActivityRepository", (it) => {
  it.effect("uses the client canonical sequence-null-last order", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const threadId = ThreadId.make("thread-canonical-activity-order");
      const turnId = TurnId.make("turn-canonical-activity-order");
      const base = {
        threadId,
        turnId,
        tone: "info" as const,
        kind: "runtime.note",
        payload: {},
        activityRevision: 1,
      };

      yield* repository.upsert({
        ...base,
        activityId: EventId.make("activity-unsequenced"),
        summary: "unsequenced",
        createdAt: "2026-07-17T00:00:00.000Z",
      });
      yield* repository.upsert({
        ...base,
        activityId: EventId.make("activity-sequence-2"),
        summary: "sequence two",
        sequence: 2,
        createdAt: "2026-07-17T00:00:02.000Z",
      });
      yield* repository.upsert({
        ...base,
        activityId: EventId.make("activity-sequence-1"),
        summary: "sequence one",
        sequence: 1,
        createdAt: "2026-07-17T00:00:01.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.deepStrictEqual(
        rows.map((row) => row.activityId),
        [
          EventId.make("activity-sequence-1"),
          EventId.make("activity-sequence-2"),
          EventId.make("activity-unsequenced"),
        ],
      );
    }),
  );

  it.effect("allows same-membership updates and rejects activity membership moves", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const activityId = EventId.make("activity-immutable-membership");
      const threadId = ThreadId.make("thread-immutable-membership");
      const base = {
        activityId,
        threadId,
        turnId: null,
        tone: "tool" as const,
        kind: "tool.completed",
        summary: "original",
        payload: { detail: "original" },
        activityRevision: 1,
        createdAt: "2026-07-17T00:00:00.000Z",
      };

      yield* repository.upsert(base);
      yield* repository.upsert({
        ...base,
        summary: "updated",
        payload: { detail: "updated" },
        activityRevision: 2,
      });

      const moveError = yield* repository
        .upsert({
          ...base,
          turnId: TurnId.make("turn-immutable-membership-other"),
          activityRevision: 3,
        })
        .pipe(Effect.flip);
      assert.match(moveError.message, /membership is immutable/);

      const rows = yield* repository.listByThreadId({ threadId });
      assert.deepStrictEqual(rows, [
        {
          ...base,
          summary: "updated",
          payload: { detail: "updated" },
          activityRevision: 2,
        },
      ]);
    }),
  );

  it.effect("reads only the latest matching task activity", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-latest-task-activity");

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        )
        VALUES
          (
            'activity-task-unrelated-tool', ${threadId}, NULL, 'tool', 'tool.completed',
            'large tool output', 'not-json', 1, '2026-03-01T00:00:00.000Z'
          ),
          (
            'activity-task-started', ${threadId}, NULL, 'info', 'task.started',
            'started', '{"taskId":"task-1","title":"Initial title"}', 2,
            '2026-03-01T00:00:01.000Z'
          ),
          (
            'activity-task-progress', ${threadId}, NULL, 'info', 'task.progress',
            'progress', '{"taskId":"task-1","title":"Updated title"}', 3,
            '2026-03-01T00:00:02.000Z'
          ),
          (
            'activity-task-other', ${threadId}, NULL, 'info', 'task.progress',
            'other', '{"taskId":"task-2","title":"Other title"}', 4,
            '2026-03-01T00:00:03.000Z'
          )
      `;

      yield* repository.upsert({
        activityId: EventId.make("activity-task-untitled"),
        activityRevision: 1,
        threadId,
        turnId: null,
        tone: "info",
        kind: "task.progress",
        summary: "Still running",
        payload: { taskId: "task-1" },
        sequence: 5,
        createdAt: "2026-03-01T00:00:04.000Z",
      });
      yield* repository.upsert({
        activityId: EventId.make("activity-task-blank-title"),
        activityRevision: 1,
        threadId,
        turnId: null,
        tone: "info",
        kind: "task.progress",
        summary: "Still running",
        payload: { taskId: "task-1", title: " \t\n\u00a0" },
        sequence: 6,
        createdAt: "2026-03-01T00:00:05.000Z",
      });

      const recent = yield* repository.listByThreadId({
        threadId,
        activityKinds: ["task.progress"],
        limit: 2,
      });
      assert.deepEqual(
        recent.map((entry) => entry.activityId),
        ["activity-task-untitled", "activity-task-blank-title"],
      );

      const activity = yield* repository.getLatestTaskActivity({
        threadId,
        taskId: "task-1",
      });
      assert.equal(activity._tag, "Some");
      if (activity._tag === "Some") {
        assert.equal(activity.value.activityId, EventId.make("activity-task-progress"));
        assert.deepEqual(activity.value.payload, {
          taskId: "task-1",
          title: "Updated title",
        });
      }

      assert.equal(
        (yield* repository.getLatestTaskActivity({ threadId, taskId: "missing" }))._tag,
        "None",
      );
    }),
  );
});
