import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-message-delivery");
const newMessageId = MessageId.make("message-new");

function makeReadModel(): OrchestrationReadModel {
  const queuedMessages: NonNullable<OrchestrationThread["queuedMessages"]> = [
    {
      messageId: MessageId.make("message-older"),
      threadId,
      text: "Older follow-up",
      attachments: [],
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: threadId,
        projectId: ProjectId.make("project-message-delivery"),
        title: "Message delivery",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: [],
        queuedMessages,
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: {
          threadId,
          status: "running",
          providerName: "Codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      },
    ],
    usageLimits: [],
    updatedAt: NOW,
  };
}

function messageCommand(
  delivery?: "immediate" | "queued",
): Extract<OrchestrationCommand, { readonly type: "thread.message.queue" }> {
  return {
    type: "thread.message.queue",
    commandId: CommandId.make(`command-${delivery ?? "default"}`),
    threadId,
    message: {
      messageId: newMessageId,
      role: "user",
      text: "Review finding for active work",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    ...(delivery === undefined ? {} : { delivery }),
    createdAt: NOW,
  };
}

it.layer(NodeServices.layer)("thread message delivery", (it) => {
  it.effect("keeps explicit and legacy queue submissions behind active work", () =>
    Effect.gen(function* () {
      for (const delivery of [undefined, "queued"] as const) {
        const result = yield* decideOrchestrationCommand({
          command: messageCommand(delivery),
          readModel: makeReadModel(),
        });
        const events = Array.isArray(result) ? result : [result];
        expect(events.map((event) => event.type)).toEqual(["thread.message-queued"]);
      }
    }),
  );

  it.effect("dispatches an immediate message ahead of older queued work", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: messageCommand("immediate"),
        readModel: makeReadModel(),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.message-queued",
        "thread.queued-message-dispatched",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
      const dispatched = events.find((event) => event.type === "thread.queued-message-dispatched");
      if (dispatched?.type === "thread.queued-message-dispatched") {
        expect(dispatched.payload.messageId).toBe(newMessageId);
      }
    }),
  );
});
