import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const UPDATED_AT = "2026-01-01T00:00:00.000Z";

const readModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  threads: [
    {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Manual title",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: UPDATED_AT,
      updatedAt: UPDATED_AT,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
  usageLimits: [],
  updatedAt: UPDATED_AT,
};

it.layer(NodeServices.layer)("title regeneration decider", (it) => {
  it.effect("marks direct title edits as manual", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-manual-title"),
          threadId: ThreadId.make("thread-1"),
          title: "Curated title",
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.meta-updated");
      if (event.type === "thread.meta-updated") {
        expect(event.payload.title).toBe("Curated title");
        expect(event.payload.titleMode).toBe("manual");
      }
    }),
  );

  it.effect("rejects a generated title when its expected title is stale", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-stale-generated-title"),
          threadId: ThreadId.make("thread-1"),
          title: "Generated title",
          titleMode: "automatic",
          expectedTitle: "Older title",
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.meta-updated");
      if (event.type === "thread.meta-updated") {
        expect(event.payload.title).toBeUndefined();
        expect(event.payload.titleMode).toBeUndefined();
      }
    }),
  );

  it.effect("does not replace a manual title with the first-turn title seed", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-first-turn"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-1"),
            role: "user",
            text: "Start the work",
            attachments: [],
          },
          titleSeed: "Manual title",
          interactionMode: "default",
          runtimeMode: "full-access",
          createdAt: UPDATED_AT,
        },
        readModel: {
          ...readModel,
          threads: readModel.threads.map((thread) => ({ ...thread, titleMode: "manual" as const })),
        },
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.some((event) => event.type === "thread.meta-updated")).toBe(false);
    }),
  );

  it.effect("preserves updatedAt for a stale completion", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.title.regeneration.complete",
          commandId: CommandId.make("cmd-regeneration-complete"),
          threadId: ThreadId.make("thread-1"),
          requestId: CommandId.make("cmd-old-regeneration-request"),
          title: "Generated title",
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.meta-updated");
      if (event.type === "thread.meta-updated") {
        expect(event.payload).toEqual({
          threadId: ThreadId.make("thread-1"),
          updatedAt: UPDATED_AT,
        });
      }
    }),
  );
});
