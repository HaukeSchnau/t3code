import {
  EMPTY_DURABLE_COMMAND_OUTBOX_DOCUMENT,
  decodeDurableCommandOutboxDocument,
  encodeDurableCommandOutboxDocument,
  makeDurableCommandDeliveryPlan,
  type DurableClientCommand,
  type DurableCommandOutboxDocument,
  type DurableCommandOutboxEntry,
} from "@t3tools/client-runtime/operations/command-outbox";
import {
  CommandOutboxStorage,
  CommandOutboxStorageError,
} from "@t3tools/client-runtime/platform/command-outbox";
import {
  classifyCommandDeliveryFailure,
  makeCommandOutbox,
  type CommandOutboxService,
} from "@t3tools/client-runtime/state/command-outbox";
import type { CommandId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useSyncExternalStore } from "react";

import { readEnvironmentApi } from "./environmentApi";

const DATABASE_NAME = "t3code:durable-command-outbox";
const DATABASE_VERSION = 2;
const STORE_NAME = "outbox";
const ACCEPTED_STORE_NAME = "accepted-awaiting-projection";
const DOCUMENT_KEY = "document";

type TimerHandle = unknown;

export interface DurableCommandOutboxControllerOptions {
  readonly storage: CommandOutboxStorage["Service"];
  readonly acceptedProjectionStorage?: CommandOutboxStorage["Service"];
  readonly dispatch: (environmentId: EnvironmentId, command: DurableClientCommand) => Promise<void>;
  readonly now?: () => string;
  readonly setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  readonly clearTimer?: (handle: TimerHandle) => void;
  /** @deprecated Use withMutationLock. */
  readonly withLock?: <A>(task: () => Promise<A>) => Promise<A>;
  readonly withMutationLock?: <A>(task: () => Promise<A>) => Promise<A>;
  readonly withDrainLeadership?: (task: () => Promise<void>) => Promise<boolean>;
}

export interface DurableCommandOutboxController {
  readonly enqueue: (
    environmentId: EnvironmentId,
    command: DurableClientCommand,
  ) => Promise<DurableCommandOutboxEntry>;
  readonly flush: () => Promise<void>;
  readonly wake: () => void;
  readonly snapshot: () => ReadonlyArray<DurableCommandOutboxEntry>;
  readonly acceptedProjectionSnapshot: () => ReadonlyArray<DurableCommandOutboxEntry>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly cancelPending: (commandId: CommandId) => Promise<void>;
  readonly replacePending: (
    commandId: CommandId,
    replacement: DurableClientCommand,
  ) => Promise<DurableCommandOutboxEntry>;
  readonly replaceRejected: (
    commandId: CommandId,
    replacement: DurableClientCommand,
  ) => Promise<DurableCommandOutboxEntry>;
  readonly discardRejected: (commandId: CommandId) => Promise<void>;
  readonly confirmProjected: (messageIds: ReadonlySet<string>) => Promise<void>;
  readonly dispose: () => void;
}

function storageError(operation: "load" | "save", cause: unknown) {
  return new CommandOutboxStorageError({
    operation,
    message: `Could not ${operation} the durable command outbox: ${String(cause)}`,
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable in this browser context."));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
      if (!request.result.objectStoreNames.contains(ACCEPTED_STORE_NAME)) {
        request.result.createObjectStore(ACCEPTED_STORE_NAME);
      }
    });
    request.addEventListener("error", () => reject(request.error ?? new Error("Open failed")));
    request.addEventListener("success", () => resolve(request.result));
  });
}

async function loadBrowserDocument(storeName = STORE_NAME): Promise<DurableCommandOutboxDocument> {
  const database = await openDatabase();
  try {
    const raw = await new Promise<unknown>((resolve, reject) => {
      const request = database
        .transaction(storeName, "readonly")
        .objectStore(storeName)
        .get(DOCUMENT_KEY);
      request.addEventListener("error", () => reject(request.error ?? new Error("Read failed")));
      request.addEventListener("success", () => resolve(request.result));
    });
    if (raw === undefined) return EMPTY_DURABLE_COMMAND_OUTBOX_DOCUMENT;
    return decodeDurableCommandOutboxDocument(raw);
  } finally {
    database.close();
  }
}

async function saveBrowserDocument(
  document: DurableCommandOutboxDocument,
  storeName = STORE_NAME,
): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.addEventListener("error", () =>
        reject(transaction.error ?? new Error("Write failed")),
      );
      transaction.addEventListener("complete", () => resolve());
      transaction
        .objectStore(storeName)
        .put(encodeDurableCommandOutboxDocument(document), DOCUMENT_KEY);
    });
  } finally {
    database.close();
  }
}

export const browserCommandOutboxStorage = CommandOutboxStorage.of({
  load: Effect.tryPromise({
    try: () => loadBrowserDocument(),
    catch: (cause) => storageError("load", cause),
  }),
  save: (document) =>
    Effect.tryPromise({
      try: () => saveBrowserDocument(document),
      catch: (cause) => storageError("save", cause),
    }),
});

export const browserAcceptedProjectionStorage = CommandOutboxStorage.of({
  load: Effect.tryPromise({
    try: () => loadBrowserDocument(ACCEPTED_STORE_NAME),
    catch: (cause) => storageError("load", cause),
  }),
  save: (document) =>
    Effect.tryPromise({
      try: () => saveBrowserDocument(document, ACCEPTED_STORE_NAME),
      catch: (cause) => storageError("save", cause),
    }),
});

function earliestRetryDelay(
  entries: ReadonlyArray<DurableCommandOutboxEntry>,
  now: string,
): number | null {
  let earliest: number | null = null;
  const nowMs = Date.parse(now);
  for (const entry of entries) {
    if (entry.state._tag !== "Retrying") continue;
    const delay = Math.max(0, Date.parse(entry.state.retryNotBefore) - nowMs);
    earliest = earliest === null ? delay : Math.min(earliest, delay);
  }
  return earliest;
}

function classifyWebCommandFailure(cause: unknown) {
  if (typeof cause === "object" && cause !== null && "_tag" in cause) {
    const tag = String(cause._tag);
    if (
      tag.includes("Invariant") ||
      tag.includes("Validation") ||
      tag.includes("NotFound") ||
      tag.includes("Unauthorized") ||
      tag.includes("Forbidden") ||
      tag === "OrchestrationCommandPreviouslyRejectedError" ||
      tag === "OrchestrationCommandReceiptMismatchError"
    ) {
      return classifyCommandDeliveryFailure(cause, "permanent");
    }
  }
  return classifyCommandDeliveryFailure(cause);
}

export function createDurableCommandOutboxController(
  options: DurableCommandOutboxControllerOptions,
): DurableCommandOutboxController {
  let memoryAcceptedDocument = EMPTY_DURABLE_COMMAND_OUTBOX_DOCUMENT;
  const acceptedProjectionStorage =
    options.acceptedProjectionStorage ??
    CommandOutboxStorage.of({
      load: Effect.sync(() => memoryAcceptedDocument),
      save: (document) => Effect.sync(() => void (memoryAcceptedDocument = document)),
    });
  const now = options.now ?? (() => new Date().toISOString());
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const withMutationLock = options.withMutationLock ?? options.withLock ?? (async (task) => task());
  const withDrainLeadership =
    options.withDrainLeadership ??
    (async (task) => {
      await task();
      return true;
    });
  const listeners = new Set<() => void>();
  let current: ReadonlyArray<DurableCommandOutboxEntry> = [];
  let acceptedProjection: ReadonlyArray<DurableCommandOutboxEntry> = [];
  let disposed = false;
  let timer: TimerHandle | null = null;
  let activeFlush: Promise<void> | null = null;
  let flushRequested = false;
  let recoveryAttempt = 0;
  const loadService = (recoverInterruptedDeliveries = false) =>
    Effect.runPromise(makeCommandOutbox(options.storage, now(), recoverInterruptedDeliveries));
  const loadAcceptedProjectionService = () =>
    Effect.runPromise(makeCommandOutbox(acceptedProjectionStorage, now(), false));

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const publish = async (service: CommandOutboxService) => {
    current = await Effect.runPromise(service.entries);
    notify();
  };

  const publishAcceptedProjection = async (service: CommandOutboxService) => {
    acceptedProjection = await Effect.runPromise(service.entries);
    notify();
  };

  const schedule = async (service: CommandOutboxService) => {
    if (disposed) return;
    if (timer !== null) clearTimer(timer);
    timer = null;
    const delay = earliestRetryDelay(await Effect.runPromise(service.entries), now());
    if (delay === null) return;
    timer = setTimer(() => {
      timer = null;
      void flush();
    }, delay);
  };

  const scheduleRecovery = () => {
    if (disposed || timer !== null) return;
    recoveryAttempt += 1;
    const delay = Math.min(1_000 * 2 ** (recoveryAttempt - 1), 16_000);
    timer = setTimer(() => {
      timer = null;
      void flush();
    }, delay);
  };

  const runFlush = async () => {
    try {
      const acquiredLeadership = await withDrainLeadership(async () => {
        await withMutationLock(async () => {
          const recovered = await loadService(true);
          await publish(recovered);
        });
        recoveryAttempt = 0;
        while (true) {
          if (disposed) break;
          const delivery = await withMutationLock(async () => {
            const service = await loadService(false);
            const accepted = await loadAcceptedProjectionService();
            const acceptedCommandIds = new Set(
              (await Effect.runPromise(accepted.entries)).map(
                (entry) => entry.plan.command.commandId,
              ),
            );
            let entry = (await Effect.runPromise(service.ready(now())))[0];
            while (entry !== undefined && acceptedCommandIds.has(entry.plan.command.commandId)) {
              // A prior attempt persisted acceptance but crashed before removing
              // retry ownership. Finish that local cleanup without dispatching
              // the already accepted command again.
              await Effect.runPromise(service.begin(entry.plan.command.commandId, now()));
              await Effect.runPromise(service.complete(entry.plan.command.commandId));
              entry = (await Effect.runPromise(service.ready(now())))[0];
            }
            if (entry === undefined) {
              await publish(service);
              await schedule(service);
              return null;
            }
            const commandId = entry.plan.command.commandId;
            await Effect.runPromise(service.begin(commandId, now()));
            await publish(service);
            return entry;
          });
          if (delivery === null) break;
          let dispatchFailure: unknown | null = null;
          try {
            await options.dispatch(delivery.plan.environmentId, delivery.plan.command);
          } catch (cause) {
            dispatchFailure = cause;
          }
          await withMutationLock(async () => {
            const service = await loadService(false);
            if (dispatchFailure === null) {
              // Persist the accepted intent before removing it from the retry
              // queue. This bridges the acknowledgement-to-projection window,
              // including reloads, without sending an already accepted command
              // merely to keep its optimistic message visible.
              const accepted = await loadAcceptedProjectionService();
              const acceptedEntries = await Effect.runPromise(accepted.entries);
              if (
                !acceptedEntries.some(
                  (entry) => entry.plan.command.commandId === delivery.plan.command.commandId,
                )
              ) {
                await Effect.runPromise(accepted.enqueue(delivery.plan));
              }
              await publishAcceptedProjection(accepted);
              await Effect.runPromise(service.complete(delivery.plan.command.commandId));
            } else {
              await Effect.runPromise(
                service.fail(
                  delivery.plan.command.commandId,
                  classifyWebCommandFailure(dispatchFailure),
                  now(),
                ),
              );
            }
            await publish(service);
          });
        }
      });
      if (!acquiredLeadership) {
        scheduleRecovery();
      }
    } catch (cause) {
      console.error("Durable command outbox recovery failed", cause);
      scheduleRecovery();
    }
  };

  const flush = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    flushRequested = true;
    if (activeFlush !== null) return activeFlush;
    activeFlush = (async () => {
      while (true) {
        flushRequested = false;
        await runFlush();
        if (!flushRequested || disposed) break;
      }
    })().finally(() => {
      activeFlush = null;
    });
    return activeFlush;
  };

  void withMutationLock(async () => {
    await publishAcceptedProjection(await loadAcceptedProjectionService());
    await publish(await loadService(false));
  })
    .then(() => flush())
    .catch((cause) => {
      console.error("Could not initialize durable command outbox", cause);
      scheduleRecovery();
    });

  return {
    enqueue: async (environmentId, command) => {
      const entry = await withMutationLock(async () => {
        const service = await loadService(false);
        const persisted = await Effect.runPromise(
          service.enqueue(
            makeDurableCommandDeliveryPlan({
              environmentId,
              enqueuedAt: now(),
              command,
            }),
          ),
        );
        await publish(service);
        return persisted;
      });
      void flush();
      return entry;
    },
    flush,
    wake: () => {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      void flush();
    },
    snapshot: () => current,
    acceptedProjectionSnapshot: () => acceptedProjection,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cancelPending: (commandId) =>
      withMutationLock(async () => {
        const service = await loadService(false);
        await Effect.runPromise(service.cancelPending(commandId));
        await publish(service);
        void flush();
      }),
    replacePending: (commandId, replacement) =>
      withMutationLock(async () => {
        const service = await loadService(false);
        const original = (await Effect.runPromise(service.entries)).find(
          (entry) => entry.plan.command.commandId === commandId,
        );
        if (!original) throw new Error(`Command ${commandId} is not queued`);
        const replaced = await Effect.runPromise(
          service.replacePending(
            commandId,
            makeDurableCommandDeliveryPlan({
              environmentId: original.plan.environmentId,
              enqueuedAt: now(),
              command: replacement,
            }),
          ),
        );
        await publish(service);
        void flush();
        return replaced;
      }),
    replaceRejected: (commandId, replacement) =>
      withMutationLock(async () => {
        const service = await loadService(false);
        const original = (await Effect.runPromise(service.entries)).find(
          (entry) => entry.plan.command.commandId === commandId,
        );
        if (!original) throw new Error(`Command ${commandId} is not queued`);
        const replaced = await Effect.runPromise(
          service.replaceRejected(
            commandId,
            makeDurableCommandDeliveryPlan({
              environmentId: original.plan.environmentId,
              enqueuedAt: now(),
              command: replacement,
            }),
          ),
        );
        await publish(service);
        void flush();
        return replaced;
      }),
    discardRejected: (commandId) =>
      withMutationLock(async () => {
        const service = await loadService(false);
        await Effect.runPromise(service.removeRejected(commandId));
        await publish(service);
        void flush();
      }),
    confirmProjected: (messageIds) =>
      withMutationLock(async () => {
        if (messageIds.size === 0) return;
        const accepted = await loadAcceptedProjectionService();
        for (const entry of await Effect.runPromise(accepted.entries)) {
          if (messageIds.has(entry.plan.command.message.messageId)) {
            await Effect.runPromise(accepted.cancelPending(entry.plan.command.commandId));
          }
        }
        await publishAcceptedProjection(accepted);
      }),
    dispose: () => {
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      listeners.clear();
    },
  };
}

let liveController: DurableCommandOutboxController | null = null;
let liveListenerCleanup: (() => void) | null = null;

function withBrowserMutationLock<A>(task: () => Promise<A>): Promise<A> {
  if (typeof navigator === "undefined" || navigator.locks === undefined) return task();
  return navigator.locks.request("t3code:durable-command-outbox:mutation", task);
}

function withBrowserDrainLeadership(task: () => Promise<void>): Promise<boolean> {
  if (typeof navigator === "undefined" || navigator.locks === undefined) {
    return task().then(() => true);
  }
  return navigator.locks.request(
    "t3code:durable-command-outbox:drain-leader",
    { ifAvailable: true },
    async (lock) => {
      if (lock === null) return false;
      await task();
      return true;
    },
  );
}

export function attachDurableOutboxWakeListeners(
  controller: Pick<DurableCommandOutboxController, "wake">,
  windowTarget: Pick<Window, "addEventListener" | "removeEventListener">,
  documentTarget: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">,
): () => void {
  const visibilityListener = () => {
    if (documentTarget.visibilityState === "visible") controller.wake();
  };
  windowTarget.addEventListener("online", controller.wake);
  documentTarget.addEventListener("visibilitychange", visibilityListener);
  return () => {
    windowTarget.removeEventListener("online", controller.wake);
    documentTarget.removeEventListener("visibilitychange", visibilityListener);
  };
}

export function durableCommandOutbox(): DurableCommandOutboxController {
  if (liveController !== null) return liveController;
  liveController = createDurableCommandOutboxController({
    storage: browserCommandOutboxStorage,
    acceptedProjectionStorage: browserAcceptedProjectionStorage,
    dispatch: async (environmentId, command) => {
      const api = readEnvironmentApi(environmentId);
      if (!api) throw new Error(`Environment API unavailable for ${environmentId}`);
      await api.orchestration.dispatchCommand(command);
    },
    withMutationLock: withBrowserMutationLock,
    withDrainLeadership: withBrowserDrainLeadership,
  });
  if (typeof window !== "undefined") {
    liveListenerCleanup = attachDurableOutboxWakeListeners(liveController, window, document);
  }
  return liveController;
}

const EMPTY_ENTRIES: ReadonlyArray<DurableCommandOutboxEntry> = [];

export function useDurableCommandOutboxEntries(): ReadonlyArray<DurableCommandOutboxEntry> {
  const controller = typeof window === "undefined" ? null : durableCommandOutbox();
  return useSyncExternalStore(
    controller?.subscribe ?? (() => () => undefined),
    controller?.snapshot ?? (() => EMPTY_ENTRIES),
    () => EMPTY_ENTRIES,
  );
}

export function useAcceptedCommandProjectionEntries(): ReadonlyArray<DurableCommandOutboxEntry> {
  const controller = typeof window === "undefined" ? null : durableCommandOutbox();
  return useSyncExternalStore(
    controller?.subscribe ?? (() => () => undefined),
    controller?.acceptedProjectionSnapshot ?? (() => EMPTY_ENTRIES),
    () => EMPTY_ENTRIES,
  );
}

export function selectDurableOutboxMessages(
  entries: ReadonlyArray<DurableCommandOutboxEntry>,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  alreadyVisibleMessageIds: ReadonlySet<string> = new Set(),
) {
  const seen = new Set<string>();
  return entries.flatMap((entry) => {
    if (
      entry.plan.environmentId !== environmentId ||
      entry.plan.command.threadId !== threadId ||
      alreadyVisibleMessageIds.has(entry.plan.command.message.messageId) ||
      seen.has(entry.plan.command.message.messageId)
    ) {
      return [];
    }
    seen.add(entry.plan.command.message.messageId);
    return [entry.plan.command.message];
  });
}

export function shouldClearComposerAfterDurableEnqueue(
  submittedDraftRevision: unknown,
  currentDraftRevision: unknown,
): boolean {
  return JSON.stringify(submittedDraftRevision) === JSON.stringify(currentDraftRevision);
}

export function __resetDurableCommandOutboxForTests(): void {
  liveListenerCleanup?.();
  liveListenerCleanup = null;
  liveController?.dispose();
  liveController = null;
}
