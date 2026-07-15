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
const DATABASE_VERSION = 1;
const STORE_NAME = "outbox";
const DOCUMENT_KEY = "document";

type TimerHandle = unknown;

export interface DurableCommandOutboxControllerOptions {
  readonly storage: CommandOutboxStorage["Service"];
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
  readonly subscribe: (listener: () => void) => () => void;
  readonly discardRejected: (commandId: CommandId) => Promise<void>;
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
    });
    request.addEventListener("error", () => reject(request.error ?? new Error("Open failed")));
    request.addEventListener("success", () => resolve(request.result));
  });
}

async function loadBrowserDocument(): Promise<DurableCommandOutboxDocument> {
  const database = await openDatabase();
  try {
    const raw = await new Promise<unknown>((resolve, reject) => {
      const request = database
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
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

async function saveBrowserDocument(document: DurableCommandOutboxDocument): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.addEventListener("error", () =>
        reject(transaction.error ?? new Error("Write failed")),
      );
      transaction.addEventListener("complete", () => resolve());
      transaction
        .objectStore(STORE_NAME)
        .put(encodeDurableCommandOutboxDocument(document), DOCUMENT_KEY);
    });
  } finally {
    database.close();
  }
}

export const browserCommandOutboxStorage = CommandOutboxStorage.of({
  load: Effect.tryPromise({
    try: loadBrowserDocument,
    catch: (cause) => storageError("load", cause),
  }),
  save: (document) =>
    Effect.tryPromise({
      try: () => saveBrowserDocument(document),
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
  let disposed = false;
  let timer: TimerHandle | null = null;
  let activeFlush: Promise<void> | null = null;
  let flushRequested = false;
  let recoveryAttempt = 0;
  const loadService = (recoverInterruptedDeliveries = false) =>
    Effect.runPromise(makeCommandOutbox(options.storage, now(), recoverInterruptedDeliveries));

  const publish = async (service: CommandOutboxService) => {
    current = await Effect.runPromise(service.entries);
    for (const listener of listeners) listener();
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
      await withDrainLeadership(async () => {
        await withMutationLock(async () => {
          const recovered = await loadService(true);
          await publish(recovered);
        });
        recoveryAttempt = 0;
        while (true) {
          if (disposed) break;
          const delivery = await withMutationLock(async () => {
            const service = await loadService(false);
            const entry = (await Effect.runPromise(service.ready(now())))[0];
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

  void withMutationLock(async () => publish(await loadService(false)))
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
            makeDurableCommandDeliveryPlan({ environmentId, enqueuedAt: now(), command }),
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
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    discardRejected: (commandId) =>
      withMutationLock(async () => {
        const service = await loadService(false);
        await Effect.runPromise(service.removeRejected(commandId));
        await publish(service);
        void flush();
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
