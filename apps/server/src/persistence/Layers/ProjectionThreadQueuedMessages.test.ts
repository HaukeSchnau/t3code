import { ComposerContextId, MessageId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionThreadQueuedMessageRepository } from "../Services/ProjectionThreadQueuedMessages.ts";
import { ProjectionThreadQueuedMessageRepositoryLive } from "./ProjectionThreadQueuedMessages.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

it.layer(
  ProjectionThreadQueuedMessageRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
)("queued message context persistence", (it) => {
  it.effect(
    "reads structured context from SQLite and clears it when a queued message is replaced",
    () =>
      Effect.gen(function* () {
        const repository = yield* ProjectionThreadQueuedMessageRepository;
        const message = {
          messageId: MessageId.make("queued-context"),
          threadId: ThreadId.make("thread-context"),
          text: "Use [skill](t3-context://v1/skill/skill)",
          attachments: [],
          origin: null,
          context: {
            version: 1 as const,
            records: [
              {
                version: 1 as const,
                contextId: ComposerContextId.make("skill"),
                kind: "skill" as const,
                name: "example",
                label: "skill",
              },
            ],
          },
          modelSelection: null,
          titleSeed: null,
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          createdAt: "2026-09-21T12:00:00.000Z",
          updatedAt: "2026-09-21T12:00:00.000Z",
        };
        yield* repository.upsert(message);
        expect(Option.getOrThrow(yield* repository.getByMessageId(message))).toEqual(message);
        expect(yield* repository.listByThreadId(message)).toEqual([message]);
        yield* repository.upsert({ ...message, context: null, text: "Replacement" });
        expect(Option.getOrThrow(yield* repository.getByMessageId(message)).context).toBeNull();
      }),
  );
});
