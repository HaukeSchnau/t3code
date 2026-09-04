import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-message-delivery");
const newMessageId = MessageId.make("message-new");
const delegatedThreadId = ThreadId.make("thread-delegated");
const delegatedTurnId = TurnId.make("turn-delegated-first");

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

function delegationNotificationCommand(): Extract<
  OrchestrationCommand,
  { readonly type: "thread.message.queue" }
> {
  return {
    type: "thread.message.queue",
    commandId: CommandId.make("command-delegation-completed"),
    threadId,
    message: {
      messageId: MessageId.make("message-delegation-completed"),
      role: "user",
      text: "Delegated thread is completed.",
      attachments: [],
      origin: {
        type: "delegation",
        threadId: delegatedThreadId,
        turnId: delegatedTurnId,
        outcome: "completed",
      },
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    delivery: "queued",
    createdAt: "2026-01-01T00:00:03.000Z",
  };
}

function restartDelegatedThreadCommand(): Extract<
  OrchestrationCommand,
  { readonly type: "thread.message.queue" }
> {
  return {
    type: "thread.message.queue",
    commandId: CommandId.make("command-restart-delegated-thread"),
    threadId: delegatedThreadId,
    message: {
      messageId: MessageId.make("message-remediation-turn"),
      role: "user",
      text: "Start remediation.",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    delivery: "immediate",
    createdAt: "2026-01-01T00:00:02.000Z",
  };
}

function withDelegatedThread(
  model: OrchestrationReadModel,
  sessionStatus: "ready" | "starting" | "running" | "error",
): OrchestrationReadModel {
  const restarted = sessionStatus !== "ready";
  const worker: OrchestrationThread = {
    ...model.threads[0]!,
    id: delegatedThreadId,
    title: "Delegated worker",
    latestTurn: {
      turnId: delegatedTurnId,
      state: "completed",
      requestedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.250Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      assistantMessageId: null,
    },
    messages: restarted
      ? [
          {
            id: MessageId.make("message-remediation-turn"),
            role: "user",
            text: "Start remediation.",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: "2026-01-01T00:00:02.000Z",
            updatedAt: "2026-01-01T00:00:02.000Z",
          },
        ]
      : [],
    queuedMessages: [],
    session: {
      threadId: delegatedThreadId,
      status: sessionStatus,
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: sessionStatus === "running" ? TurnId.make("turn-delegated-second") : null,
      lastError: sessionStatus === "error" ? "Provider start failed." : null,
      updatedAt: restarted ? "2026-01-01T00:00:02.000Z" : "2026-01-01T00:00:01.000Z",
    },
  };
  return { ...model, threads: [...model.threads, worker] };
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

  it.effect("queues a completion only while its delegated turn is still current", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: delegationNotificationCommand(),
        readModel: withDelegatedThread(makeReadModel(), "ready"),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual(["thread.message-queued"]);
    }),
  );

  it.effect("rejects a stale completion after completed -> send -> starting/running", () =>
    Effect.gen(function* () {
      let restartedModel = withDelegatedThread(makeReadModel(), "ready");
      const restart = yield* decideOrchestrationCommand({
        command: restartDelegatedThreadCommand(),
        readModel: restartedModel,
      });
      const restartEvents = Array.isArray(restart) ? restart : [restart];
      for (let index = 0; index < restartEvents.length; index += 1) {
        restartedModel = yield* projectEvent(restartedModel, {
          ...restartEvents[index]!,
          sequence: index + 1,
        });
      }
      const beforeProviderStart = yield* decideOrchestrationCommand({
        command: delegationNotificationCommand(),
        readModel: restartedModel,
      });
      expect(beforeProviderStart).toEqual([]);

      for (const sessionStatus of ["starting", "running", "error"] as const) {
        const result = yield* decideOrchestrationCommand({
          command: delegationNotificationCommand(),
          readModel: withDelegatedThread(makeReadModel(), sessionStatus),
        });
        expect(result).toEqual([]);
      }
    }),
  );
});
