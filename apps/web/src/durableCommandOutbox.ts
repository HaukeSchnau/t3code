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
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
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

export function createDurableCommandOutboxController(
  options: DurableCommandOutboxControllerOptions,
): DurableCommandOutboxController {
  const now = options.now ?? (() => new Date().toISOString());
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const listeners = new Set<() => void>();
  let current: ReadonlyArray<DurableCommandOutboxEntry> = [];
  let disposed = false;
  let timer: TimerHandle | null = null;
  let activeFlush: Promise<void> | null = null;
  let flushRequested = false;
  const servicePromise: Promise<CommandOutboxService> = Effect.runPromise(
    makeCommandOutbox(options.storage, now()),
  );

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

  const runFlush = async () => {
    const service = await servicePromise;
    while (true) {
      if (disposed) break;
      const ready = await Effect.runPromise(service.ready(now()));
      const entry = ready[0];
      if (entry === undefined) break;
      const commandId = entry.plan.command.commandId;
      await Effect.runPromise(service.begin(commandId, now()));
      await publish(service);
      try {
        await options.dispatch(entry.plan.environmentId, entry.plan.command);
        await Effect.runPromise(service.complete(commandId));
      } catch (cause) {
        await Effect.runPromise(
          service.fail(commandId, classifyCommandDeliveryFailure(cause), now()),
        );
      }
      await publish(service);
    }
    await schedule(service);
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

  void servicePromise.then((service) => publish(service).then(() => flush()));

  return {
    enqueue: async (environmentId, command) => {
      const service = await servicePromise;
      const entry = await Effect.runPromise(
        service.enqueue(
          makeDurableCommandDeliveryPlan({ environmentId, enqueuedAt: now(), command }),
        ),
      );
      await publish(service);
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
    dispose: () => {
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      listeners.clear();
    },
  };
}

let liveController: DurableCommandOutboxController | null = null;

export function durableCommandOutbox(): DurableCommandOutboxController {
  if (liveController !== null) return liveController;
  liveController = createDurableCommandOutboxController({
    storage: browserCommandOutboxStorage,
    dispatch: async (environmentId, command) => {
      const api = readEnvironmentApi(environmentId);
      if (!api) throw new Error(`Environment API unavailable for ${environmentId}`);
      await api.orchestration.dispatchCommand(command);
    },
  });
  if (typeof window !== "undefined") {
    window.addEventListener("online", liveController.wake);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") liveController?.wake();
    });
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
) {
  const seen = new Set<string>();
  return entries.flatMap((entry) => {
    if (
      entry.plan.environmentId !== environmentId ||
      entry.plan.command.threadId !== threadId ||
      seen.has(entry.plan.command.message.messageId)
    ) {
      return [];
    }
    seen.add(entry.plan.command.message.messageId);
    return [entry.plan.command.message];
  });
}

export function __resetDurableCommandOutboxForTests(): void {
  liveController?.dispose();
  liveController = null;
}
