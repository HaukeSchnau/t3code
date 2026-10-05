import { assert, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const threadId = ThreadId.make("thread:observed-image-deletion");
const observedImage = {
  type: "image" as const,
  id: ChatAttachmentId.make("thread-observed-00000000-0000-4000-8000-000000000001"),
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 4,
};

it.effect.each(["sqlite", "memory"] as const)(
  "deletes observed images with the thread's other attachments in %s",
  (storage) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const instanceId = ProviderInstanceId.make("codex");
      yield* store.apply({
        id: EventId.make("event:observed-image-thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          id: threadId,
          projectId: ProjectId.make("project:observed-image-deletion"),
          title: "Observed images",
          providerInstanceId: instanceId,
          modelSelection: { instanceId, model: "test" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdBy: "user",
          creationSource: "web",
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* store.apply({
        id: EventId.make("event:observed-image-message"),
        type: "message.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: MessageId.make("message:observed-image"),
          threadId,
          runId: null,
          nodeId: null,
          role: "user",
          text: "Check the screenshot",
          attachments: [{ ...observedImage, id: ChatAttachmentId.make("user_image") }],
          streaming: false,
          createdBy: "user",
          creationSource: "web",
          createdAt: now,
          updatedAt: now,
        },
      });
      // Viewing the same image twice shares one copy; a tool without a copy adds nothing.
      for (const [index, copy] of [observedImage, observedImage, undefined].entries()) {
        const item: OrchestrationV2TurnItem = {
          id: TurnItemId.make(`item:observed-image:${index}`),
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: index + 1,
          status: "completed",
          title: "Read screen.png",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "dynamic_tool",
          toolName: "view_image",
          viewedImagePath: "/workspace/screen.png",
          input: { path: "/workspace/screen.png" },
          ...(copy === undefined ? {} : { observedImage: copy }),
        };
        yield* store.apply({
          id: EventId.make(`event:observed-image-item:${index}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: item,
        });
      }

      assert.deepEqual([...(yield* store.getThreadAttachmentIds(threadId))].sort(), [
        observedImage.id,
        "user_image",
      ]);
    }).pipe(
      Effect.provide(
        storage === "sqlite"
          ? Layer.mergeAll(
              SqlitePersistenceMemory,
              ProjectionStore.layer.pipe(Layer.provide(SqlitePersistenceMemory)),
            )
          : Layer.merge(SqlitePersistenceMemory, ProjectionStore.layerMemory),
      ),
    ),
);
