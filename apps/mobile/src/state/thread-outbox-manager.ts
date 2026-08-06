import {
  EMPTY_DURABLE_COMMAND_OUTBOX_DOCUMENT,
  type DurableCommandOutboxDocument,
  type DurableCommandOutboxEntry,
  type DurableCommandState,
} from "@t3tools/client-runtime/operations/command-outbox";
import {
  CommandOutboxStorage,
  CommandOutboxStorageError,
} from "@t3tools/client-runtime/platform/command-outbox";
import {
  classifyCommandDeliveryFailure,
  CommandOutboxStateError,
  makeCommandOutbox,
  type CommandDeliveryFailureInput,
  type CommandOutboxService,
} from "@t3tools/client-runtime/state/command-outbox";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
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
      let messages = flattenQueuedThreadMessages(
        groupQueuedThreadMessages([...persistedMessages, ...currentMessages()]),
      );
      const service = await outbox();
      let entries = await Effect.runPromise(service.entries);
      let queuedIds = new Set(entries.map((entry) => entry.plan.command.commandId));

      for (const discarded of messages.filter((message) => message.discardedAt)) {
        const entry = entries.find(
          (candidate) => candidate.plan.command.commandId === discarded.commandId,
        );
        if (entry?.state._tag === "Rejected") {
          await Effect.runPromise(service.removeRejected(discarded.commandId));
        }
        await options.storage
          .remove(discarded)
          .catch((cause) => warn("[thread-outbox] deferred discarded record cleanup", cause));
      }
      messages = messages.filter((message) => !message.discardedAt);
      entries = await Effect.runPromise(service.entries);
      queuedIds = new Set(entries.map((entry) => entry.plan.command.commandId));

      // Finish acknowledgement cleanup after a crash at either side of the
      // lifecycle/presentation boundary. The marker itself is written before
      // shared completion, so this path never resends an acknowledged effect.
      for (const acknowledged of messages.filter((message) => message.acknowledgedAt)) {
        const entry = entries.find(
          (candidate) => candidate.plan.command.commandId === acknowledged.commandId,
        );
        if (entry) {
          if (entry.state._tag !== "Delivering") {
            const readyAt =
              entry.state._tag === "Retrying"
                ? entry.state.retryNotBefore
                : acknowledged.acknowledgedAt!;
            await Effect.runPromise(service.begin(acknowledged.commandId, readyAt));
          }
          await Effect.runPromise(service.complete(acknowledged.commandId));
        }
        await options.storage
          .remove(acknowledged)
          .catch((cause) => warn("[thread-outbox] deferred acknowledged record cleanup", cause));
      }
      messages = messages.filter((message) => !message.acknowledgedAt);
      entries = await Effect.runPromise(service.entries);
      queuedIds = new Set(entries.map((entry) => entry.plan.command.commandId));

      // Replacement uses a small durable intent marker. If the shared swap
      // committed, the replacement wins and stale presentation is removed;
      // otherwise the old intent wins and the uncommitted replacement is
      // discarded. Both crash boundaries converge idempotently on load.
      const committedReplacements = messages.filter(
        (message) => message.replacesCommandId && queuedIds.has(message.commandId),
      );
      const supersededIds = new Set(
        committedReplacements.flatMap((message) => [
          ...(message.supersedesCommandIds ?? []),
          message.replacesCommandId!,
        ]),
      );
      for (const candidate of messages) {
        const uncommittedReplacement =
          candidate.replacesCommandId !== undefined && !queuedIds.has(candidate.commandId);
        if (supersededIds.has(candidate.commandId) || uncommittedReplacement) {
          await options.storage
            .remove(candidate)
            .catch((cause) => warn("[thread-outbox] deferred replacement record cleanup", cause));
          messages = messages.filter((message) => message.messageId !== candidate.messageId);
        }
      }
      // A lifecycle without presentation cannot be a legitimate accepted
      // intent: presentation is always written first. It is an obsolete entry
      // from an older fallback generation, so retire it before it can block a
      // newer command on the same thread.
      const presentedIds = new Set(messages.map((message) => message.commandId));
      for (const entry of await Effect.runPromise(service.entries)) {
        const commandId = entry.plan.command.commandId;
        if (presentedIds.has(commandId)) continue;
        if (entry.state._tag === "Pending") {
          await Effect.runPromise(service.cancelPending(commandId));
        } else if (entry.state._tag === "Rejected") {
          await Effect.runPromise(service.removeRejected(commandId));
        } else {
          const readyAt =
            entry.state._tag === "Retrying" ? entry.state.retryNotBefore : entry.state.startedAt;
          if (entry.state._tag !== "Delivering") {
            await Effect.runPromise(service.begin(commandId, readyAt));
          }
          await Effect.runPromise(service.complete(commandId));
        }
      }
      entries = await Effect.runPromise(service.entries);
      queuedIds = new Set(entries.map((entry) => entry.plan.command.commandId));
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

  // The queued atom drives the composer's immediate "queued" feedback, so it
  // is published synchronously; the durable write happens behind it and rolls
  // the message back out if it fails (durability only matters for crash
  // recovery, not for the in-session queue).
  const enqueue = (message: QueuedThreadMessage): Promise<void> => {
    const previousMessage = currentMessages().find(
      (candidate) => candidate.messageId === message.messageId,
    );
    setMessages([
      ...currentMessages().filter((candidate) => candidate.messageId !== message.messageId),
      message,
    ]);
    return serialize(async () => {
      const service = await outbox();
      const existing = (await Effect.runPromise(service.entries)).find(
        (entry) => entry.plan.command.commandId === message.commandId,
      );
      if (existing !== undefined && existing.state._tag !== "Pending") {
        const current = currentMessages();
        if (current.some((candidate) => candidate === message)) {
          const restoredMessages = current.flatMap((candidate) => {
            if (candidate !== message) return [candidate];
            if (previousMessage === undefined) return [];
            return [previousMessage];
          });
          setMessages(restoredMessages);
        }
        throw new ThreadOutboxManagerError({
          operation: "enqueue",
          environmentId: message.environmentId,
          threadId: message.threadId,
          messageId: message.messageId,
          cause: new CommandOutboxStateError({
            reason: "duplicate-command",
            commandId: message.commandId,
            message: `Command ${message.commandId} has already crossed the delivery boundary`,
          }),
        });
      }
      try {
        await options.storage.write(message);
      } catch (cause) {
        // Roll back by reference, not messageId: a retry enqueue with the same
        // id may have optimistically replaced this attempt while the write was
        // in flight, and its entry must survive this attempt's failure.
        setMessages(currentMessages().filter((candidate) => candidate !== message));
        throw new ThreadOutboxManagerError({
          operation: "enqueue",
          environmentId: message.environmentId,
          threadId: message.threadId,
          messageId: message.messageId,
          cause,
        });
      }
      // A repeated native share delivery may reuse its stable message and
      // command identity. Replace a still-pending lifecycle entry so its
      // durable payload matches the authoritative presentation record.
      if (existing?.state._tag === "Pending") {
        await Effect.runPromise(service.cancelPending(message.commandId));
      }
      await Effect.runPromise(service.enqueue(makeQueuedThreadDeliveryPlan(message)));
      await refreshDeliveryStates(service);
    });
  };

  // Resolves once all pending mutations (including any in-flight enqueue
  // write) have settled, reporting whether the message is still queued. The
  // drain awaits this before dispatching so a message whose durable write
  // later fails can never have been delivered first.
  const confirmQueued = (message: QueuedThreadMessage): Promise<boolean> =>
    serialize(async () => currentMessages().some((candidate) => candidate === message));

  // Rewrites an already-queued message. A no-op when the message has been
  // removed in the meantime (e.g. deleted or delivered), so a trailing editor
  // flush can never resurrect it. Returns whether the message was updated.
  const update = (previous: QueuedThreadMessage, message: QueuedThreadMessage): Promise<boolean> =>
    serialize(async () => {
      const exists = currentMessages().some(
        (candidate) => candidate.messageId === previous.messageId,
      );
      if (!exists) {
        return false;
      }
      const service = await outbox();
      const replacement: QueuedThreadMessage = {
        ...message,
        replacesCommandId: previous.commandId,
        supersedesCommandIds: [
          previous.commandId,
          ...(previous.supersedesCommandIds ?? []),
          ...(previous.replacesCommandId ? [previous.replacesCommandId] : []),
        ],
      };
      try {
        await options.storage.write(replacement);
      } catch (cause) {
        throw new ThreadOutboxManagerError({
          operation: "update",
          environmentId: message.environmentId,
          threadId: message.threadId,
          messageId: message.messageId,
          cause,
        });
      }
      try {
        await Effect.runPromise(
          service.replacePending(previous.commandId, makeQueuedThreadDeliveryPlan(replacement)),
        );
      } catch (cause) {
        await options.storage.remove(replacement).catch(() => undefined);
        throw cause;
      }
      await refreshDeliveryStates(service);
      await options.storage
        .remove(previous)
        .catch((cause) => warn("[thread-outbox] deferred obsolete replacement cleanup", cause));
      setMessages([
        ...currentMessages().filter((candidate) => candidate.messageId !== previous.messageId),
        replacement,
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
      const service = await outbox();
      const acknowledged = { ...message, acknowledgedAt: new Date().toISOString() };
      await options.storage.write(acknowledged);
      await Effect.runPromise(service.complete(message.commandId));
      await options.storage
        .remove(acknowledged)
        .catch((cause) => warn("[thread-outbox] deferred acknowledged record cleanup", cause));
      setMessages(
        currentMessages().filter((candidate) => candidate.messageId !== message.messageId),
      );
      await refreshDeliveryStates(service);
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
        service.fail(message.commandId, classifyCommandDeliveryFailure(error, classification), at),
      );
      await refreshDeliveryStates(service);
      return entry;
    });

  const discardRejected = (message: QueuedThreadMessage): Promise<void> =>
    serialize(async () => {
      const service = await outbox();
      const discarded = { ...message, discardedAt: new Date().toISOString() };
      await options.storage.write(discarded);
      await Effect.runPromise(service.removeRejected(message.commandId));
      await options.storage
        .remove(discarded)
        .catch((cause) => warn("[thread-outbox] deferred discarded record cleanup", cause));
      setMessages(
        currentMessages().filter((candidate) => candidate.messageId !== message.messageId),
      );
      await refreshDeliveryStates(service);
    });

  return {
    queuedMessagesByThreadKeyAtom,
    deliveryStatesAtom,
    serialize,
    load,
    enqueue,
    confirmQueued,
    update,
    remove,
    clearEnvironment,
    ready,
    begin,
    complete,
    fail,
    discardRejected,
  };
}
