import { describe, expect, it } from "@effect/vitest";
import {
  EMPTY_DURABLE_COMMAND_OUTBOX_DOCUMENT,
  type DurableCommandOutboxDocument,
} from "@t3tools/client-runtime/operations/command-outbox";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";

import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  groupQueuedThreadMessages,
  isQueuedThreadCreationSendable,
  modelSelectionsEqual,
  resolveThreadOutboxDeliveryAction,
  resolveThreadOutboxFailureAction,
  resolveQueuedThreadSettings,
  shouldRetryThreadOutboxDelivery,
  threadOutboxRetryDelayMs,
  type QueuedThreadMessage,
} from "./thread-outbox-model";
import { createThreadOutboxManager, ThreadOutboxManagerError } from "./thread-outbox-manager";
import {
  nextCommandOutboxGenerationSequence,
  type ThreadOutboxStorage,
} from "./thread-outbox-storage";

function queuedMessage(input: {
  readonly environmentId?: string;
  readonly threadId?: string;
  readonly messageId: string;
  readonly createdAt: string;
}): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make(input.environmentId ?? "environment-1"),
    threadId: ThreadId.make(input.threadId ?? "thread-1"),
    messageId: MessageId.make(input.messageId),
    commandId: CommandId.make(`command-${input.messageId}`),
    text: input.messageId,
    attachments: [],
    createdAt: input.createdAt,
  };
}

describe("thread outbox", () => {
  it("groups messages by scoped thread and preserves creation order", () => {
    const later = queuedMessage({
      messageId: "message-2",
      createdAt: "2026-06-08T10:00:02.000Z",
    });
    const earlier = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    expect(groupQueuedThreadMessages([later, earlier])).toEqual({
      "environment-1:thread-1": [earlier, later],
    });
  });

  it("decodes the persisted schema and rejects incomplete messages", () => {
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    expect(
      decodeQueuedThreadMessage({
        schemaVersion: 1,
        ...message,
      }),
    ).toEqual(message);
    expect(() =>
      decodeQueuedThreadMessage({
        schemaVersion: 1,
        environmentId: "environment-1",
      }),
    ).toThrow();
  });

  it("persists the exact selector snapshot while remaining compatible with v1 messages", () => {
    const legacyMessage = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const selectedMessage = {
      ...legacyMessage,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
      runtimeMode: "approval-required",
      interactionMode: "plan",
    } satisfies QueuedThreadMessage;

    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(selectedMessage))).toEqual(
      selectedMessage,
    );
    expect(
      resolveQueuedThreadSettings(legacyMessage, {
        modelSelection: selectedMessage.modelSelection,
        runtimeMode: selectedMessage.runtimeMode,
        interactionMode: selectedMessage.interactionMode,
      }),
    ).toEqual({
      modelSelection: selectedMessage.modelSelection,
      runtimeMode: selectedMessage.runtimeMode,
      interactionMode: selectedMessage.interactionMode,
    });
  });

  it("compares model options as part of the queued settings change", () => {
    const base = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "medium" }],
    } as const;

    expect(modelSelectionsEqual(base, base)).toBe(true);
    expect(
      modelSelectionsEqual(base, {
        ...base,
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      }),
    ).toBe(false);
  });

  it("backs off queued delivery retries and caps them at sixteen seconds", () => {
    expect([1, 2, 3, 4, 5, 6].map(threadOutboxRetryDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 16_000,
    ]);
  });

  it("orders lifecycle generations monotonically even for same-millisecond saves", () => {
    const first = nextCommandOutboxGenerationSequence([], 0);
    const firstName = `command-outbox.${first.toString().padStart(16, "0")}.json`;
    const second = nextCommandOutboxGenerationSequence([firstName], first);
    expect([first, second]).toEqual([1, 2]);
    expect(second).toBeGreaterThan(first);
  });

  it("serializes mutations even when an earlier mutation is slower", async () => {
    const registry = AtomRegistry.make();
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = manager.serialize(async () => {
      order.push("first:start");
      await firstBlocked;
      order.push("first:end");
    });
    const second = manager.serialize(async () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
    registry.dispose();
  });

  it("holds the mutation queue while persisted messages are loading", async () => {
    const registry = AtomRegistry.make();
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const stored = new Map([[message.messageId, message]]);
    let loadCalls = 0;
    let removeCalls = 0;
    let releaseInitialLoad!: () => void;
    const initialLoadBlocked = new Promise<void>((resolve) => {
      releaseInitialLoad = resolve;
    });
    const storage: ThreadOutboxStorage = {
      load: async () => {
        loadCalls += 1;
        if (loadCalls === 1) {
          await initialLoadBlocked;
        }
        return [...stored.values()];
      },
      write: async () => undefined,
      remove: async (candidate) => {
        removeCalls += 1;
        stored.delete(candidate.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });

    const loading = manager.load();
    await Promise.resolve();
    const clearing = manager.clearEnvironment(message.environmentId);
    await Promise.resolve();
    await Promise.resolve();

    expect(loadCalls).toBe(1);
    expect(removeCalls).toBe(0);

    releaseInitialLoad();
    await Promise.all([loading, clearing]);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    registry.dispose();
  });

  it("reports structured load failures and permits a retry", async () => {
    const registry = AtomRegistry.make();
    const loadCause = new Error("storage unavailable");
    const warnings: Array<{ message: string; error: unknown }> = [];
    let loadCalls = 0;
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => {
          loadCalls += 1;
          if (loadCalls === 1) throw loadCause;
          return [];
        },
        write: async () => undefined,
        remove: async () => undefined,
      },
      warn: (message, error) => warnings.push({ message, error }),
    });

    await manager.load();
    expect(warnings).toEqual([
      {
        message: "[thread-outbox] failed to load persisted messages",
        error: new ThreadOutboxManagerError({
          operation: "load",
          environmentId: null,
          threadId: null,
          messageId: null,
          cause: loadCause,
        }),
      },
    ]);

    await manager.load();
    expect(loadCalls).toBe(2);
    registry.dispose();
  });

  it("keeps atom state aligned with durable writes and removals", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const removalCause = new Error("remove failed");
    let failRemoval = true;
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => {
        stored.set(message.messageId, message);
      },
      remove: async (message) => {
        if (failRemoval) {
          throw removalCause;
        }
        stored.delete(message.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    await manager.enqueue(message);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });

    await expect(manager.remove(message)).rejects.toEqual(
      new ThreadOutboxManagerError({
        operation: "remove",
        environmentId: message.environmentId,
        threadId: message.threadId,
        messageId: message.messageId,
        cause: removalCause,
      }),
    );
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });

    failRemoval = false;
    await manager.remove(message);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    registry.dispose();
  });

  it("updates a queued message in place but never resurrects a removed one", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => {
        stored.set(message.messageId, message);
      },
      remove: async (message) => {
        stored.delete(message.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    await manager.enqueue(message);
    const edited = queuedMessage({
      messageId: "message-2",
      createdAt: "2026-06-08T10:00:02.000Z",
    });
    const editedPayload = { ...edited, text: "edited" };
    await expect(manager.update(message, editedPayload)).resolves.toBe(true);
    const durableEditedPayload = {
      ...editedPayload,
      replacesCommandId: message.commandId,
      supersedesCommandIds: [message.commandId],
    };
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [durableEditedPayload],
    });
    expect(stored.get(edited.messageId)).toEqual(durableEditedPayload);

    await manager.remove(durableEditedPayload);
    await expect(
      manager.update(message, { ...editedPayload, text: "stale flush" }),
    ).resolves.toBe(false);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    expect(stored.size).toBe(0);
    registry.dispose();
  });

  it("replaces edited content with fresh identities while preserving its thread", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    let commandDocument: DurableCommandOutboxDocument = EMPTY_DURABLE_COMMAND_OUTBOX_DOCUMENT;
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => void stored.set(message.messageId, message),
      remove: async (message) => void stored.delete(message.messageId),
      loadCommandOutbox: async () => commandDocument,
      saveCommandOutbox: async (document) => void (commandDocument = document),
    };
    const manager = createThreadOutboxManager({ registry, storage });
    const original = queuedMessage({
      messageId: "original-message",
      createdAt: "2026-07-15T10:00:00.000Z",
    });
    const replacement = {
      ...queuedMessage({
        messageId: "replacement-message",
        createdAt: "2026-07-15T10:00:01.000Z",
      }),
      text: "edited",
    };
    await manager.enqueue(original);
    await manager.update(original, replacement);

    const [entry] = commandDocument.entries;
    expect(entry?.plan.command.commandId).toBe(replacement.commandId);
    expect(entry?.plan.command.message.messageId).toBe(replacement.messageId);
    expect(entry?.plan.command.threadId).toBe(original.threadId);
    expect(entry?.plan.command.commandId).not.toBe(original.commandId);
    expect(entry?.plan.command.message.messageId).not.toBe(original.messageId);
    registry.dispose();
  });

  it("reconciles a committed replacement when obsolete presentation cleanup crashes", async () => {
    const stored = new Map<MessageId, QueuedThreadMessage>();
    let commandDocument: DurableCommandOutboxDocument = EMPTY_DURABLE_COMMAND_OUTBOX_DOCUMENT;
    let failOldRemoval = true;
    const original = queuedMessage({
      messageId: "old-message",
      createdAt: "2026-07-15T10:00:00.000Z",
    });
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => void stored.set(message.messageId, message),
      remove: async (message) => {
        if (message.messageId === original.messageId && failOldRemoval) {
          failOldRemoval = false;
          throw new Error("crash before obsolete cleanup");
        }
        stored.delete(message.messageId);
      },
      loadCommandOutbox: async () => commandDocument,
      saveCommandOutbox: async (document) => void (commandDocument = document),
    };
    const firstRegistry = AtomRegistry.make();
    const first = createThreadOutboxManager({ registry: firstRegistry, storage, warn: () => undefined });
    const replacement = queuedMessage({
      messageId: "new-message",
      createdAt: "2026-07-15T10:00:01.000Z",
    });
    await first.enqueue(original);
    await first.update(original, replacement);
    expect(stored.size).toBe(2);
    firstRegistry.dispose();

    const restartedRegistry = AtomRegistry.make();
    const restarted = createThreadOutboxManager({ registry: restartedRegistry, storage });
    await restarted.load();
    expect([...stored.keys()]).toEqual([replacement.messageId]);
    expect(Object.values(restartedRegistry.get(restarted.queuedMessagesByThreadKeyAtom)).flat())
      .toHaveLength(1);
    restartedRegistry.dispose();
  });

  it("rolls back an uncommitted replacement when lifecycle persistence fails", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    let commandDocument: DurableCommandOutboxDocument = EMPTY_DURABLE_COMMAND_OUTBOX_DOCUMENT;
    let failNextLifecycleSave = false;
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => void stored.set(message.messageId, message),
      remove: async (message) => void stored.delete(message.messageId),
      loadCommandOutbox: async () => commandDocument,
      saveCommandOutbox: async (document) => {
        if (failNextLifecycleSave) {
          failNextLifecycleSave = false;
          throw new Error("crash before lifecycle replacement commit");
        }
        commandDocument = document;
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });
    const original = queuedMessage({
      messageId: "old-message",
      createdAt: "2026-07-15T10:00:00.000Z",
    });
    const replacement = queuedMessage({
      messageId: "new-message",
      createdAt: "2026-07-15T10:00:01.000Z",
    });
    await manager.enqueue(original);
    failNextLifecycleSave = true;
    await expect(manager.update(original, replacement)).rejects.toThrow(
      "Failed to save the mobile command outbox",
    );
    expect([...stored.keys()]).toEqual([original.messageId]);
    expect(commandDocument.entries[0]?.plan.command.commandId).toBe(original.commandId);
    registry.dispose();
  });

  it("finishes acknowledged cleanup after presentation deletion fails", async () => {
    const stored = new Map<MessageId, QueuedThreadMessage>();
    let commandDocument: DurableCommandOutboxDocument = EMPTY_DURABLE_COMMAND_OUTBOX_DOCUMENT;
    let failAcknowledgedRemoval = true;
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => void stored.set(message.messageId, message),
      remove: async (message) => {
        if (message.acknowledgedAt && failAcknowledgedRemoval) {
          failAcknowledgedRemoval = false;
          throw new Error("crash before acknowledged cleanup");
        }
        stored.delete(message.messageId);
      },
      loadCommandOutbox: async () => commandDocument,
      saveCommandOutbox: async (document) => void (commandDocument = document),
    };
    const message = queuedMessage({
      messageId: "acknowledged-message",
      createdAt: "2026-07-15T10:00:00.000Z",
    });
    const firstRegistry = AtomRegistry.make();
    const first = createThreadOutboxManager({ registry: firstRegistry, storage, warn: () => undefined });
    await first.enqueue(message);
    await first.begin(message, "2026-07-15T10:00:00.000Z");
    await first.complete(message);
    expect(commandDocument.entries).toEqual([]);
    expect(stored.get(message.messageId)?.acknowledgedAt).toBeDefined();
    firstRegistry.dispose();

    const restartedRegistry = AtomRegistry.make();
    const restarted = createThreadOutboxManager({ registry: restartedRegistry, storage });
    await restarted.load();
    expect(stored.size).toBe(0);
    expect(restartedRegistry.get(restarted.queuedMessagesByThreadKeyAtom)).toEqual({});
    expect(commandDocument.entries).toEqual([]);
    restartedRegistry.dispose();
  });

  it("does not resurrect delivered lifecycle from a stale generation before a newer same-thread command", async () => {
    const stored = new Map<MessageId, QueuedThreadMessage>();
    let commandDocument: DurableCommandOutboxDocument = EMPTY_DURABLE_COMMAND_OUTBOX_DOCUMENT;
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => void stored.set(message.messageId, message),
      remove: async (message) => void stored.delete(message.messageId),
      loadCommandOutbox: async () => commandDocument,
      saveCommandOutbox: async (document) => void (commandDocument = document),
    };
    const delivered = queuedMessage({
      messageId: "delivered-a",
      createdAt: "2026-07-15T10:00:00.000Z",
    });
    const firstRegistry = AtomRegistry.make();
    const first = createThreadOutboxManager({ registry: firstRegistry, storage });
    await first.enqueue(delivered);
    const staleGeneration = commandDocument;
    await first.begin(delivered, delivered.createdAt);
    await first.complete(delivered);
    expect(commandDocument.entries).toEqual([]);
    firstRegistry.dispose();

    const later = queuedMessage({
      messageId: "ready-b",
      createdAt: "2026-07-15T10:00:02.000Z",
    });
    stored.set(later.messageId, later);
    // Models an authoritative newest generation becoming unreadable: the
    // high-water loader rebuilds from presentation while an older snapshot is
    // still physically present.
    commandDocument = staleGeneration;
    const restartedRegistry = AtomRegistry.make();
    const restarted = createThreadOutboxManager({ registry: restartedRegistry, storage });
    await restarted.load();
    expect(commandDocument.entries.map((entry) => entry.plan.command.commandId)).toEqual([
      later.commandId,
    ]);
    expect(await restarted.ready(later.createdAt)).toEqual([later]);
    restartedRegistry.dispose();
  });

  it("collapses transitive replacement ancestry after repeated edit cleanup crashes", async () => {
    const stored = new Map<MessageId, QueuedThreadMessage>();
    let commandDocument: DurableCommandOutboxDocument = EMPTY_DURABLE_COMMAND_OUTBOX_DOCUMENT;
    const failedRemovals = new Set<MessageId>();
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => void stored.set(message.messageId, message),
      remove: async (message) => {
        if (!failedRemovals.has(message.messageId)) {
          failedRemovals.add(message.messageId);
          throw new Error("simulated obsolete cleanup crash");
        }
        stored.delete(message.messageId);
      },
      loadCommandOutbox: async () => commandDocument,
      saveCommandOutbox: async (document) => void (commandDocument = document),
    };
    const original = queuedMessage({
      messageId: "edit-o",
      createdAt: "2026-07-15T10:00:00.000Z",
    });
    const r1 = queuedMessage({
      messageId: "edit-r1",
      createdAt: "2026-07-15T10:00:01.000Z",
    });
    const r2 = queuedMessage({
      messageId: "edit-r2",
      createdAt: "2026-07-15T10:00:02.000Z",
    });
    const firstRegistry = AtomRegistry.make();
    const first = createThreadOutboxManager({ registry: firstRegistry, storage, warn: () => undefined });
    await first.enqueue(original);
    await first.update(original, r1);
    const durableR1 = Object.values(firstRegistry.get(first.queuedMessagesByThreadKeyAtom)).flat()[0]!;
    await first.update(durableR1, r2);
    expect(stored.size).toBe(3);
    firstRegistry.dispose();

    const restartedRegistry = AtomRegistry.make();
    const restarted = createThreadOutboxManager({ registry: restartedRegistry, storage });
    await restarted.load();
    expect([...stored.keys()]).toEqual([r2.messageId]);
    expect(commandDocument.entries.map((entry) => entry.plan.command.commandId)).toEqual([
      r2.commandId,
    ]);
    restartedRegistry.dispose();
  });

  it("durably discards a permanently rejected pending task", async () => {
    const stored = new Map<MessageId, QueuedThreadMessage>();
    let commandDocument: DurableCommandOutboxDocument = EMPTY_DURABLE_COMMAND_OUTBOX_DOCUMENT;
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => void stored.set(message.messageId, message),
      remove: async (message) => void stored.delete(message.messageId),
      loadCommandOutbox: async () => commandDocument,
      saveCommandOutbox: async (document) => void (commandDocument = document),
    };
    const registry = AtomRegistry.make();
    const manager = createThreadOutboxManager({ registry, storage });
    const rejected = queuedMessage({
      messageId: "rejected-task",
      createdAt: "2026-07-15T10:00:00.000Z",
    });
    await manager.enqueue(rejected);
    await manager.begin(rejected, rejected.createdAt);
    await manager.fail(rejected, new Error("invalid task"), rejected.createdAt, "permanent");
    expect(registry.get(manager.deliveryStatesAtom)[rejected.commandId]?._tag).toBe("Rejected");
    await manager.discardRejected(rejected);
    expect(stored.size).toBe(0);
    expect(commandDocument.entries).toEqual([]);
    registry.dispose();
  });

  it("hydrates retry state and replays the frozen identity after acknowledgement loss", async () => {
    const stored = new Map<MessageId, QueuedThreadMessage>();
    let commandDocument: DurableCommandOutboxDocument =
      EMPTY_DURABLE_COMMAND_OUTBOX_DOCUMENT;
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => void stored.set(message.messageId, message),
      remove: async (message) => void stored.delete(message.messageId),
      loadCommandOutbox: async () => commandDocument,
      saveCommandOutbox: async (document) => {
        commandDocument = document;
      },
    };
    const message = queuedMessage({
      messageId: "offline-intent",
      createdAt: "2026-07-15T10:00:00.000Z",
    });
    const firstRegistry = AtomRegistry.make();
    const firstRuntime = createThreadOutboxManager({ registry: firstRegistry, storage });

    await firstRuntime.enqueue(message);
    expect(stored.get(message.messageId)).toEqual(message);
    expect(commandDocument.entries[0]?.state._tag).toBe("Pending");
    const firstAttempt = await firstRuntime.begin(message, "2026-07-15T10:00:00.000Z");
    await firstRuntime.fail(
      message,
      new Error("Socket closed after the server received the command"),
      "2026-07-15T10:00:00.000Z",
    );
    firstRegistry.dispose();

    const restartedRegistry = AtomRegistry.make();
    const restarted = createThreadOutboxManager({ registry: restartedRegistry, storage });
    await restarted.load();
    await restarted.load();
    expect(
      Object.values(restartedRegistry.get(restarted.queuedMessagesByThreadKeyAtom)).flat(),
    ).toEqual([message]);
    expect(await restarted.ready("2026-07-15T10:00:00.999Z")).toEqual([]);
    expect(await restarted.ready("2026-07-15T10:00:01.000Z")).toEqual([message]);

    const replay = await restarted.begin(message, "2026-07-15T10:00:01.000Z");
    expect(replay.plan.command).toEqual(firstAttempt.plan.command);
    await restarted.complete(message);
    expect(stored.size).toBe(0);
    expect(commandDocument.entries).toEqual([]);
    restartedRegistry.dispose();
  });

  it("only removes a missing-thread message after shell synchronization is live", () => {
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: false,
        shellStatus: "synchronizing",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("wait");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: false,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("remove");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("send");
  });

  it("sends queued creations once connected and live, removing already-created ones", () => {
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: false,
        shellStatus: "cached",
        environmentConnected: false,
        threadBusy: false,
      }),
    ).toBe("wait");
    // Connected but not yet synchronized: a previously delivered creation may
    // simply not be visible yet — sending now could duplicate the thread.
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: false,
        shellStatus: "synchronizing",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("wait");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: false,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("send");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: true,
      }),
    ).toBe("remove");
  });

  it("round-trips queued creations and gates incomplete ones from sending", () => {
    const base = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const creationMessage = {
      ...base,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      creation: {
        projectId: ProjectId.make("project-1"),
        workspaceMode: "worktree",
        branch: "main",
        worktreePath: null,
        startFromOrigin: true,
      },
    } satisfies QueuedThreadMessage;

    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(creationMessage))).toEqual(
      creationMessage,
    );
    expect(isQueuedThreadCreationSendable(creationMessage)).toBe(true);
    expect(
      isQueuedThreadCreationSendable({
        ...creationMessage,
        creation: { ...creationMessage.creation, branch: null },
      }),
    ).toBe(false);
    expect(
      isQueuedThreadCreationSendable({
        ...creationMessage,
        creation: { ...creationMessage.creation, branch: "" },
      }),
    ).toBe(false);
    expect(isQueuedThreadCreationSendable({ ...creationMessage, modelSelection: undefined })).toBe(
      false,
    );
    expect(isQueuedThreadCreationSendable(base)).toBe(false);
  });

  it("retries transport failures but drops deterministic command failures", () => {
    expect(shouldRetryThreadOutboxDelivery(new Error("Socket is not connected"))).toBe(true);
    expect(
      shouldRetryThreadOutboxDelivery({
        _tag: "ConnectionTransientError",
        message: "temporarily unavailable",
      }),
    ).toBe(true);
    expect(shouldRetryThreadOutboxDelivery(new Error("Thread no longer exists"))).toBe(false);
  });

  it("retains queued messages when settings synchronization fails before startTurn", () => {
    const deterministicFailure = new Error("Thread no longer exists");

    expect(
      resolveThreadOutboxFailureAction({
        stage: "settings-sync",
        error: deterministicFailure,
        interrupted: false,
      }),
    ).toBe("retry");
    expect(
      resolveThreadOutboxFailureAction({
        stage: "start-turn",
        error: deterministicFailure,
        interrupted: false,
      }),
    ).toBe("discard");
  });
});
