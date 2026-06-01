import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";

const seedReadModel = projectEvent(createEmptyReadModel(now), {
  sequence: 1,
  eventId: EventId.make("evt-project-create"),
  aggregateKind: "project",
  aggregateId: ProjectId.make("project-import"),
  type: "project.created",
  occurredAt: now,
  commandId: CommandId.make("cmd-project-create"),
  causationEventId: null,
  correlationId: CommandId.make("cmd-project-create"),
  metadata: {},
  payload: {
    projectId: ProjectId.make("project-import"),
    title: "Imported Project",
    workspaceRoot: "/tmp/project-import",
    defaultModelSelection: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
  },
});

it.layer(NodeServices.layer)("decider thread import", (it) => {
  it.effect("creates a thread and historical messages from one import command", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const planned = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.import",
          commandId: CommandId.make("cmd-thread-import"),
          threadId: ThreadId.make("codex-thread-1"),
          projectId: ProjectId.make("project-import"),
          title: "Imported Codex Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          messages: [
            {
              messageId: MessageId.make("codex:codex-thread-1:user-1"),
              role: "user",
              text: "Please fix the switcher.",
              turnId: TurnId.make("turn-1"),
              streaming: false,
              createdAt: "2026-01-01T00:00:01.000Z",
              updatedAt: "2026-01-01T00:00:01.000Z",
            },
            {
              messageId: MessageId.make("codex:codex-thread-1:assistant-1"),
              role: "assistant",
              text: "Done.",
              turnId: TurnId.make("turn-1"),
              streaming: false,
              createdAt: "2026-01-01T00:00:02.000Z",
              updatedAt: "2026-01-01T00:00:02.000Z",
            },
          ],
          createdAt: now,
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
      });

      const events = Array.isArray(planned) ? planned : [planned];
      expect(events.map((event) => event.type)).toEqual([
        "thread.created",
        "thread.message-sent",
        "thread.message-sent",
      ]);

      let projected = readModel;
      for (const [index, event] of events.entries()) {
        projected = yield* projectEvent(projected, { ...event, sequence: index + 2 });
      }

      const thread = projected.threads.find((entry) => entry.id === "codex-thread-1");
      expect(thread?.messages.map((message) => [message.role, message.text])).toEqual([
        ["user", "Please fix the switcher."],
        ["assistant", "Done."],
      ]);
    }),
  );

  it.effect("appends missing historical messages during sync", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const imported = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.import",
          commandId: CommandId.make("cmd-thread-import"),
          threadId: ThreadId.make("codex-thread-1"),
          projectId: ProjectId.make("project-import"),
          title: "Imported Codex Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          messages: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      let projected = readModel;
      for (const [index, event] of (Array.isArray(imported) ? imported : [imported]).entries()) {
        projected = yield* projectEvent(projected, { ...event, sequence: index + 2 });
      }

      const synced = yield* decideOrchestrationCommand({
        readModel: projected,
        command: {
          type: "thread.messages.sync",
          commandId: CommandId.make("cmd-thread-sync"),
          threadId: ThreadId.make("codex-thread-1"),
          messages: [
            {
              messageId: MessageId.make("codex:codex-thread-1:user-2"),
              role: "user",
              text: "New Codex-side prompt",
              turnId: TurnId.make("turn-2"),
              streaming: false,
              createdAt: "2026-01-01T00:00:03.000Z",
              updatedAt: "2026-01-01T00:00:03.000Z",
            },
          ],
        },
      });

      const events = Array.isArray(synced) ? synced : [synced];
      expect(events.map((event) => event.type)).toEqual(["thread.message-sent"]);
    }),
  );
});
