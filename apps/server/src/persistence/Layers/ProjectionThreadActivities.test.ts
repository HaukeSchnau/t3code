import { EventId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
});
