import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { DurableCommandOutboxEntry } from "@t3tools/client-runtime/operations/command-outbox";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import {
  projectThreadDurableOptimisticMessages,
  runQueuedMessageAction,
} from "./useThreadDurableOutbox";

const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");
const messageId = MessageId.make("message-1");

function outboxEntry(): DurableCommandOutboxEntry {
  return {
    plan: {
      schemaVersion: 1,
      environmentId,
      enqueuedAt: "2026-08-09T10:00:00.000Z",
      command: {
        type: "thread.message.queue",
        commandId: CommandId.make("command-1"),
        threadId,
        message: { messageId, role: "user", text: "Queued locally", attachments: [] },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex-default"),
          model: "gpt-5.6",
        },
        titleSeed: "Queued locally",
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-08-09T10:00:00.000Z",
      },
    },
    state: { _tag: "Pending" },
  };
}

describe("thread outbox", () => {
  it("constructs direct queued-message control commands", async () => {
    const commands: unknown[] = [];
    await runQueuedMessageAction({
      action: "delete",
      threadRef: scopeThreadRef(environmentId, threadId),
      messageId,
      dispatch: async (command) => void commands.push(command),
      makeCommandId: () => CommandId.make("command-2"),
      now: () => "2026-08-09T11:00:00.000Z",
    });

    assert.deepStrictEqual(commands, [
      {
        type: "thread.queued-message.delete",
        commandId: "command-2",
        threadId: "thread-1",
        messageId: "message-1",
        createdAt: "2026-08-09T11:00:00.000Z",
      },
    ]);
  });

  it("projects locally owned messages until the server queue owns them", () => {
    const thread = {
      environmentId,
      id: threadId,
      queuedMessages: [],
    };
    const projected = projectThreadDurableOptimisticMessages([outboxEntry()], thread);

    assert.deepStrictEqual(projected, [
      {
        id: messageId,
        role: "user",
        text: "Queued locally",
        turnId: null,
        createdAt: "2026-08-09T10:00:00.000Z",
        updatedAt: "2026-08-09T10:00:00.000Z",
        streaming: false,
      },
    ]);
    assert.deepStrictEqual(
      projectThreadDurableOptimisticMessages([outboxEntry()], {
        ...thread,
        queuedMessages: [
          {
            messageId,
            threadId,
            text: "Queued locally",
            attachments: [],
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex-default"),
              model: "gpt-5.6",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: "2026-08-09T10:00:00.000Z",
            updatedAt: "2026-08-09T10:00:00.000Z",
          },
        ],
      }),
      [],
    );
  });
});
