import {
  EMPTY_DURABLE_COMMAND_OUTBOX_DOCUMENT,
  type DurableCommandOutboxDocument,
  type DurableCommandOutboxEntry,
  type DurableCommandState,
} from "@t3tools/client-runtime/operations/command-outbox";
import { CommandOutboxStorage, CommandOutboxStorageError } from "@t3tools/client-runtime/platform/command-outbox";
import {
  classifyCommandDeliveryFailure,
  makeCommandOutbox,
  type CommandDeliveryFailureInput,
  type CommandOutboxService,
} from "@t3tools/client-runtime/state/command-outbox";
import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import {
  flattenQueuedThreadMessages,
  groupQueuedThreadMessages,
  makeQueuedThreadDeliveryPlan,
  type QueuedThreadMessage,
} from "./thread-outbox-model";
import type { ThreadOutboxStorage } from "./thread-outbox-storage";

export class ThreadOutboxManagerError extends Schema.TaggedErrorClass<ThreadOutboxManagerError>()(
  "ThreadOutboxManagerError",
  {
    operation: Schema.Literals([
      "load",
      "enqueue",
      "update",
      "remove",
      "clear-environment-load",
      "clear-environment-remove",
    ]),
    environmentId: Schema.NullOr(EnvironmentId),
    threadId: Schema.NullOr(ThreadId),
    messageId: Schema.NullOr(MessageId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread outbox operation ${this.operation} failed for environment ${this.environmentId ?? "unknown"}, thread ${this.threadId ?? "unknown"}, message ${this.messageId ?? "unknown"}.`;
  }
}

export interface ThreadOutboxManagerOptions {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly storage: ThreadOutboxStorage;
  readonly warn?: (message: string, error: unknown) => void;
}

export function createThreadOutboxManager(options: ThreadOutboxManagerOptions) {
  const queuedMessagesByThreadKeyAtom = Atom.make<
    Record<string, ReadonlyArray<QueuedThreadMessage>>
  >({}).pipe(Atom.keepAlive, Atom.withLabel("mobile:thread-outbox:queued-messages"));
  const deliveryStatesAtom = Atom.make<Readonly<Record<string, DurableCommandState>>>({}).pipe(
    Atom.keepAlive,
    Atom.withLabel("mobile:thread-outbox:delivery-states"),
  );
  const warn =
    options.warn ??
    ((message: string, error: unknown) => {
      console.warn(message, error);
    });
  let loadPromise: Promise<void> | null = null;
  let mutationQueue: Promise<void> = Promise.resolve();
  let outboxPromise: Promise<CommandOutboxService> | null = null;
  let fallbackDocument: DurableCommandOutboxDocument = EMPTY_DURABLE_COMMAND_OUTBOX_DOCUMENT;

  const commandStorage = CommandOutboxStorage.of({
    load: Effect.tryPromise({
      try: () => options.storage.loadCommandOutbox?.() ?? Promise.resolve(fallbackDocument),
      catch: (cause) =>
        new CommandOutboxStorageError({
          operation: "load",
          message: "Failed to load the mobile command outbox",
          cause,
        }),
    }),
    save: (document) =>
      Effect.tryPromise({
        try: async () => {
          if (options.storage.saveCommandOutbox) {
            await options.storage.saveCommandOutbox(document);
          } else {
            fallbackDocument = document;
          }
        },
        catch: (cause) =>
          new CommandOutboxStorageError({
            operation: "save",
            message: "Failed to save the mobile command outbox",
            cause,
          }),
      }),
  });

  const outbox = (): Promise<CommandOutboxService> =>
    (outboxPromise ??= Effect.runPromise(makeCommandOutbox(commandStorage)));

  const serialize = <A>(mutation: () => Promise<A>): Promise<A> => {
    const result = mutationQueue.then(mutation, mutation);
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const currentMessages = (): ReadonlyArray<QueuedThreadMessage> =>
    flattenQueuedThreadMessages(options.registry.get(queuedMessagesByThreadKeyAtom));

  const setMessages = (messages: ReadonlyArray<QueuedThreadMessage>): void => {
    options.registry.set(queuedMessagesByThreadKeyAtom, groupQueuedThreadMessages(messages));
  };
  const refreshDeliveryStates = async (service: CommandOutboxService): Promise<void> => {
    const entries = await Effect.runPromise(service.entries);
    options.registry.set(
      deliveryStatesAtom,
      Object.fromEntries(entries.map((entry) => [entry.plan.command.commandId, entry.state])),
    );
  };

  const load = (): Promise<void> => {
    if (loadPromise !== null) {
      return loadPromise;
    }
    loadPromise = serialize(async () => {
      const persistedMessages = await options.storage.load();
      const messages = flattenQueuedThreadMessages(
        groupQueuedThreadMessages([...persistedMessages, ...currentMessages()]),
      );
      const service = await outbox();
      const entries = await Effect.runPromise(service.entries);
      const queuedIds = new Set(entries.map((entry) => entry.plan.command.commandId));
      // Old mobile outbox files are upgraded before becoming visible. This is
      // also the crash reconciliation for a message file written immediately
      // before its shared lifecycle record.
      for (const message of messages) {
        if (!queuedIds.has(message.commandId)) {
          await Effect.runPromise(service.enqueue(makeQueuedThreadDeliveryPlan(message)));
        }
      }
      await refreshDeliveryStates(service);
      setMessages(messages);
    }).catch((cause) => {
      loadPromise = null;
      warn(
        "[thread-outbox] failed to load persisted messages",
        new ThreadOutboxManagerError({
          operation: "load",
          environmentId: null,
          threadId: null,
          messageId: null,
          cause,
        }),
      );
    });
    return loadPromise;
  };

  const enqueue = (message: QueuedThreadMessage): Promise<void> =>
    serialize(async () => {
      try {
        await options.storage.write(message);
      } catch (cause) {
        throw new ThreadOutboxManagerError({
          operation: "enqueue",
          environmentId: message.environmentId,
          threadId: message.threadId,
          messageId: message.messageId,
          cause,
        });
      }
      const service = await outbox();
      await Effect.runPromise(service.enqueue(makeQueuedThreadDeliveryPlan(message)));
      await refreshDeliveryStates(service);
      setMessages([...currentMessages(), message]);
    });

  // Rewrites an already-queued message. A no-op when the message has been
  // removed in the meantime (e.g. deleted or delivered), so a trailing editor
  // flush can never resurrect it. Returns whether the message was updated.
  const update = (
    previous: QueuedThreadMessage,
    message: QueuedThreadMessage,
  ): Promise<boolean> =>
    serialize(async () => {
      const exists = currentMessages().some(
        (candidate) => candidate.messageId === previous.messageId,
      );
      if (!exists) {
        return false;
      }
      const service = await outbox();
      await Effect.runPromise(
        service.replacePending(
          previous.commandId,
          makeQueuedThreadDeliveryPlan(message),
        ),
      );
      await refreshDeliveryStates(service);
      try {
        await options.storage.write(message);
        await options.storage.remove(previous);
      } catch (cause) {
        throw new ThreadOutboxManagerError({
          operation: "update",
          environmentId: message.environmentId,
          threadId: message.threadId,
          messageId: message.messageId,
          cause,
        });
      }
      setMessages([
        ...currentMessages().filter((candidate) => candidate.messageId !== previous.messageId),
        message,
      ]);
      return true;
    });

  const remove = (message: QueuedThreadMessage): Promise<void> =>
    serialize(async () => {
      const service = await outbox();
      await Effect.runPromise(service.cancelPending(message.commandId));
      await refreshDeliveryStates(service);
      try {
        await options.storage.remove(message);
      } catch (cause) {
        // Keep both durable views aligned when presentation-file cleanup
        // fails after the shared cancellation was persisted.
        await Effect.runPromise(service.enqueue(makeQueuedThreadDeliveryPlan(message)));
        await refreshDeliveryStates(service);
        throw new ThreadOutboxManagerError({
          operation: "remove",
          environmentId: message.environmentId,
          threadId: message.threadId,
          messageId: message.messageId,
          cause,
        });
      }
      setMessages(
        currentMessages().filter((candidate) => candidate.messageId !== message.messageId),
      );
    });

  const clearEnvironment = (environmentId: EnvironmentId): Promise<void> =>
    serialize(async () => {
      const persisted = await options.storage.load().catch((cause) => {
        warn(
          "[thread-outbox] failed to load messages while clearing environment",
          new ThreadOutboxManagerError({
            operation: "clear-environment-load",
            environmentId,
            threadId: null,
            messageId: null,
            cause,
          }),
        );
        return [];
      });
      const allMessages = flattenQueuedThreadMessages(
        groupQueuedThreadMessages([...persisted, ...currentMessages()]),
      );
      const removedMessageIds = new Set<MessageId>();

      await Promise.all(
        allMessages
          .filter((message) => message.environmentId === environmentId)
          .map(async (message) => {
            try {
              await Effect.runPromise((await outbox()).cancelPending(message.commandId));
              await options.storage.remove(message);
              removedMessageIds.add(message.messageId);
            } catch (cause) {
              warn(
                "[thread-outbox] failed to clear persisted message",
                new ThreadOutboxManagerError({
                  operation: "clear-environment-remove",
                  environmentId: message.environmentId,
                  threadId: message.threadId,
                  messageId: message.messageId,
                  cause,
                }),
              );
            }
          }),
      );

      setMessages(allMessages.filter((message) => !removedMessageIds.has(message.messageId)));
      await refreshDeliveryStates(await outbox());
    });

  const ready = (at: string): Promise<ReadonlyArray<QueuedThreadMessage>> =>
    serialize(async () => {
      const entries = await Effect.runPromise((await outbox()).ready(at));
      const ids = new Set(entries.map((entry) => entry.plan.command.commandId));
      return currentMessages().filter((message) => ids.has(message.commandId));
    });

  const begin = (message: QueuedThreadMessage, at: string): Promise<DurableCommandOutboxEntry> =>
    serialize(async () => {
      const service = await outbox();
      const entry = await Effect.runPromise(service.begin(message.commandId, at));
      await refreshDeliveryStates(service);
      return entry;
    });

  const complete = (message: QueuedThreadMessage): Promise<void> =>
    serialize(async () => {
      await Effect.runPromise((await outbox()).complete(message.commandId));
      await options.storage.remove(message);
      setMessages(currentMessages().filter((candidate) => candidate.messageId !== message.messageId));
      await refreshDeliveryStates(await outbox());
    });

  const fail = (
    message: QueuedThreadMessage,
    error: unknown,
    at: string,
    classification?: CommandDeliveryFailureInput["classification"],
  ): Promise<DurableCommandOutboxEntry> =>
    serialize(async () => {
      const service = await outbox();
      const entry = await Effect.runPromise(
        service.fail(
          message.commandId,
          classifyCommandDeliveryFailure(error, classification),
          at,
        ),
      );
      await refreshDeliveryStates(service);
      return entry;
    });

  return {
    queuedMessagesByThreadKeyAtom,
    deliveryStatesAtom,
    serialize,
    load,
    enqueue,
    update,
    remove,
    clearEnvironment,
    ready,
    begin,
    complete,
    fail,
  };
}
