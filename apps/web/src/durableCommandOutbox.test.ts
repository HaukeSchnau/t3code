import {
  EMPTY_DURABLE_COMMAND_OUTBOX_DOCUMENT,
  type DurableCommandOutboxDocument,
} from "@t3tools/client-runtime/operations/command-outbox";
import { CommandOutboxStorage } from "@t3tools/client-runtime/platform/command-outbox";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import {
  createDurableCommandOutboxController,
  selectDurableOutboxMessages,
} from "./durableCommandOutbox";

const T0 = "2026-07-15T10:00:00.000Z";
const T1 = "2026-07-15T10:00:01.000Z";
const environmentId = EnvironmentId.make("remote");
const threadId = ThreadId.make("thread-1");

function command(id = "command-1", messageId = "message-1") {
  return {
    type: "thread.turn.start" as const,
    commandId: CommandId.make(id),
    threadId,
    message: {
      messageId: MessageId.make(messageId),
      role: "user" as const,
      text: "Saved on the train",
      attachments: [],
    },
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    titleSeed: "Saved on the train",
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    createdAt: T0,
  };
}

function memoryStorage(initial = EMPTY_DURABLE_COMMAND_OUTBOX_DOCUMENT) {
  let persisted: DurableCommandOutboxDocument = initial;
  return {
    storage: CommandOutboxStorage.of({
      load: Effect.sync(() => persisted),
      save: (document) => Effect.sync(() => void (persisted = document)),
    }),
    read: () => persisted,
  };
}

describe("web durable command outbox", () => {
  it("accepts and persists a message while transport is offline", async () => {
    const memory = memoryStorage();
    const controller = createDurableCommandOutboxController({
      storage: memory.storage,
      now: () => T0,
      dispatch: async () => {
        throw new Error("WebSocket closed");
      },
    });

    await controller.enqueue(environmentId, command());
    await controller.flush();

    expect(memory.read().entries).toHaveLength(1);
    expect(memory.read().entries[0]?.plan.command.commandId).toBe("command-1");
    expect(memory.read().entries[0]?.state._tag).toBe("Retrying");
    controller.dispose();
  });

  it("flushes the frozen identity when connectivity returns", async () => {
    const memory = memoryStorage();
    let online = false;
    let clock = T0;
    const delivered: string[] = [];
    const controller = createDurableCommandOutboxController({
      storage: memory.storage,
      now: () => clock,
      setTimer: () => 1,
      clearTimer: () => undefined,
      dispatch: async (_environmentId, value) => {
        delivered.push(value.commandId);
        if (!online) throw new Error("WebSocket closed");
      },
    });

    await controller.enqueue(environmentId, command());
    await controller.flush();
    online = true;
    clock = T1;
    controller.wake();
    await controller.flush();

    expect(delivered).toEqual(["command-1", "command-1"]);
    expect(memory.read().entries).toEqual([]);
    controller.dispose();
  });

  it("retries acknowledgement loss without minting a second identity", async () => {
    const memory = memoryStorage();
    let clock = T0;
    let attempts = 0;
    const identities: string[] = [];
    const controller = createDurableCommandOutboxController({
      storage: memory.storage,
      now: () => clock,
      setTimer: () => 1,
      clearTimer: () => undefined,
      dispatch: async (_environmentId, value) => {
        identities.push(value.commandId);
        attempts += 1;
        if (attempts === 1) throw new Error("Socket closed before response");
      },
    });

    await controller.enqueue(environmentId, command());
    await controller.flush();
    clock = T1;
    controller.wake();
    await controller.flush();

    expect(identities).toEqual(["command-1", "command-1"]);
    expect(memory.read().entries).toEqual([]);
    controller.dispose();
  });

  it("hydrates persisted work after a runtime reload", async () => {
    const memory = memoryStorage();
    const first = createDurableCommandOutboxController({
      storage: memory.storage,
      now: () => T0,
      setTimer: () => 1,
      clearTimer: () => undefined,
      dispatch: async () => {
        throw new Error("offline");
      },
    });
    await first.enqueue(environmentId, command());
    await first.flush();
    first.dispose();

    const delivered: string[] = [];
    const second = createDurableCommandOutboxController({
      storage: memory.storage,
      now: () => T1,
      dispatch: async (_environmentId, value) => void delivered.push(value.commandId),
    });
    await second.flush();

    expect(delivered).toEqual(["command-1"]);
    expect(memory.read().entries).toEqual([]);
    second.dispose();
  });

  it("projects one optimistic message for one persisted intent", async () => {
    const memory = memoryStorage();
    const controller = createDurableCommandOutboxController({
      storage: memory.storage,
      now: () => T0,
      setTimer: () => 1,
      clearTimer: () => undefined,
      dispatch: async () => {
        throw new Error("offline");
      },
    });
    await controller.enqueue(environmentId, command());
    await controller.flush();

    const visible = selectDurableOutboxMessages(controller.snapshot(), environmentId, threadId);
    expect(visible.map((message) => message.messageId)).toEqual(["message-1"]);
    controller.dispose();
  });
});
