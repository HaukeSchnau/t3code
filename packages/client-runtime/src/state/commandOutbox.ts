import type { CommandId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { isTransportConnectionErrorMessage } from "../errors/transport.ts";

const MAX_RETRY_DELAY_MS = 16_000;

export const CommandOutboxFailureClassification = Schema.Literals([
  // The command never reached the environment, so it is safe to drop or edit.
  "transient",
  // The command may have been accepted. Only a retry with the same id is safe.
  "ambiguous",
  // The environment decided. Retrying the same id replays the rejection.
  "permanent",
]);
export type CommandOutboxFailureClassification = typeof CommandOutboxFailureClassification.Type;

export const CommandOutboxFailure = Schema.Struct({
  classification: CommandOutboxFailureClassification,
  message: Schema.String,
});
export type CommandOutboxFailure = typeof CommandOutboxFailure.Type;

/** Timestamps are epoch milliseconds. */
export const CommandOutboxState = Schema.Union([
  Schema.TaggedStruct("Pending", {}),
  Schema.TaggedStruct("Delivering", { attempt: Schema.Int, startedAt: Schema.Number }),
  Schema.TaggedStruct("Retrying", {
    attempt: Schema.Int,
    retryAt: Schema.Number,
    failure: CommandOutboxFailure,
  }),
  Schema.TaggedStruct("Rejected", { attempt: Schema.Int, failure: CommandOutboxFailure }),
]);
export type CommandOutboxState = typeof CommandOutboxState.Type;

/** A command delivered with this id; the server's command receipts make a retry idempotent. */
export interface CommandOutboxCommand {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
}

export interface CommandOutboxEntry<C extends CommandOutboxCommand> {
  /** Assigned by the store and increasing, so it orders each thread's commands. */
  readonly id: number;
  readonly enqueuedAt: number;
  readonly command: C;
  readonly state: CommandOutboxState;
}

/** Thrown by a delivery that knows how its failure must be treated. */
export class CommandOutboxDeliveryError extends Schema.TaggedError<CommandOutboxDeliveryError>()(
  "CommandOutboxDeliveryError",
  {
    classification: CommandOutboxFailureClassification,
    message: Schema.String,
  },
) {}

const isCommandOutboxDeliveryError = Schema.is(CommandOutboxDeliveryError);

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return typeof error === "string" ? error : "The message could not be sent.";
}

/**
 * Unknown failures count as decided by the environment. Retrying them forever
 * would block the thread; the client removes a "rejected" command whose
 * message the server turns out to hold.
 */
export function classifyCommandDeliveryFailure(error: unknown): CommandOutboxFailure {
  if (isCommandOutboxDeliveryError(error)) {
    return { classification: error.classification, message: error.message };
  }
  const message = errorMessage(error);
  if (typeof error === "object" && error !== null && "_tag" in error) {
    switch (error._tag) {
      case "EnvironmentRpcUnavailableError":
      case "EnvironmentNotRegisteredError":
      case "ConnectionTransientError":
        return { classification: "transient", message };
      case "RpcClientError":
        return { classification: "ambiguous", message };
    }
  }
  return {
    classification: isTransportConnectionErrorMessage(message) ? "ambiguous" : "permanent",
    message,
  };
}

export function commandOutboxRetryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), MAX_RETRY_DELAY_MS);
}

/** Only intent that never reached the network boundary, or that the server refused, may leave. */
export function canDiscardCommandOutboxEntry(
  entry: CommandOutboxEntry<CommandOutboxCommand>,
): boolean {
  return (
    entry.state._tag === "Pending" ||
    entry.state._tag === "Rejected" ||
    (entry.state._tag === "Retrying" && entry.state.failure.classification === "transient")
  );
}

function threadKey(command: CommandOutboxCommand): string {
  return JSON.stringify([command.environmentId, command.threadId]);
}

function isDue(entry: CommandOutboxEntry<CommandOutboxCommand>, now: number): boolean {
  return (
    entry.state._tag === "Pending" ||
    (entry.state._tag === "Retrying" && entry.state.retryAt <= now)
  );
}

function threadHeads<C extends CommandOutboxCommand>(
  entries: ReadonlyArray<CommandOutboxEntry<C>>,
): ReadonlyArray<CommandOutboxEntry<C>> {
  const heads = new Map<string, CommandOutboxEntry<C>>();
  for (const entry of [...entries].sort((left, right) => left.id - right.id)) {
    const key = threadKey(entry.command);
    if (!heads.has(key)) heads.set(key, entry);
  }
  return [...heads.values()];
}

/**
 * Each thread delivers its commands in order: only the oldest entry of a
 * thread can be ready, and a delivering, waiting, or rejected head holds the
 * rest of its thread back without blocking other threads.
 */
function readyCommandOutboxEntries<C extends CommandOutboxCommand>(
  entries: ReadonlyArray<CommandOutboxEntry<C>>,
  now: number,
): ReadonlyArray<CommandOutboxEntry<C>> {
  return threadHeads(entries).filter((entry) => isDue(entry, now));
}

function nextRetryAt<C extends CommandOutboxCommand>(
  entries: ReadonlyArray<CommandOutboxEntry<C>>,
  include: (command: C) => boolean,
): number | null {
  let next: number | null = null;
  for (const head of threadHeads(entries)) {
    if (head.state._tag !== "Retrying" || !include(head.command)) continue;
    next = next === null ? head.state.retryAt : Math.min(next, head.state.retryAt);
  }
  return next;
}

function entriesSignature(entries: ReadonlyArray<CommandOutboxEntry<CommandOutboxCommand>>) {
  return JSON.stringify(
    entries.map((entry) => [
      entry.id,
      entry.command.commandId,
      entry.state._tag,
      "attempt" in entry.state ? entry.state.attempt : null,
      entry.state._tag === "Retrying" ? entry.state.retryAt : null,
      "failure" in entry.state ? entry.state.failure.message : null,
    ]),
  );
}

export interface CommandOutboxStore<C extends CommandOutboxCommand> {
  readonly list: () => Promise<ReadonlyArray<CommandOutboxEntry<C>>>;
  /** Appends atomically and rejects a command id that is already stored. */
  readonly add: (entry: Omit<CommandOutboxEntry<C>, "id">) => Promise<CommandOutboxEntry<C>>;
  /**
   * Atomic read-modify-write of one entry. `change` returns the replacement,
   * `null` to delete, or `undefined` to keep the entry. Resolves to the stored
   * replacement, `null` after a delete, and `undefined` when nothing changed.
   */
  readonly update: (
    id: number,
    change: (entry: CommandOutboxEntry<C>) => CommandOutboxEntry<C> | null | undefined,
  ) => Promise<CommandOutboxEntry<C> | null | undefined>;
}

export interface CommandOutboxControllerOptions<C extends CommandOutboxCommand> {
  readonly store: CommandOutboxStore<C>;
  /**
   * Sends the command. Resolving means the environment accepted it; throwing
   * fails the attempt as classified by `classifyCommandDeliveryFailure`.
   * `record` persists preparation results, such as uploaded attachment ids, so
   * a retry does not repeat them.
   */
  readonly deliver: (
    entry: CommandOutboxEntry<C>,
    record: (command: C) => Promise<void>,
  ) => Promise<void>;
  /** Whether the command's environment can be reached right now. */
  readonly canDeliver: (command: C) => boolean;
  /**
   * Runs the drain while no other process sharing the store drains. Holding it
   * proves that a stored delivery in progress was abandoned.
   */
  readonly withDrainLock?: (drain: () => Promise<void>) => Promise<void>;
  readonly onRejected?: (entry: CommandOutboxEntry<C>) => void;
  /** Store failures; the drain backs off and tries again. */
  readonly onError: (error: unknown) => void;
  /** Epoch milliseconds. */
  readonly now: () => number;
  /** Returns a cancel function. */
  readonly setTimer: (callback: () => void, delayMs: number) => () => void;
}

export interface CommandOutboxController<C extends CommandOutboxCommand> {
  readonly entries: () => ReadonlyArray<CommandOutboxEntry<C>>;
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * Stores the command before any network attempt. With
   * `acknowledgementLost`, a delivery already happened without a reply, so the
   * entry starts as an ambiguous retry that cannot be discarded.
   */
  readonly enqueue: (
    command: C,
    options?: { readonly acknowledgementLost?: boolean },
  ) => Promise<CommandOutboxEntry<C>>;
  /** Removes an entry that cannot have been accepted; resolves to it, or null. */
  readonly discard: (id: number) => Promise<CommandOutboxEntry<C> | null>;
  /** Retries a waiting entry now. A rejected entry needs a fresh command id. */
  readonly retry: (id: number, freshCommandId: CommandId) => Promise<void>;
  /** Drops entries whose commands the environment is known to hold. */
  readonly settle: (delivered: (command: C) => boolean) => Promise<void>;
  /** Reloads entries another process changed, then drains. */
  readonly refresh: () => Promise<void>;
  /** Drains now, skipping any retry delay timer; resolves when the drain settles. */
  readonly wake: () => Promise<void>;
  readonly dispose: () => void;
}

export function createCommandOutboxController<C extends CommandOutboxCommand>(
  options: CommandOutboxControllerOptions<C>,
): CommandOutboxController<C> {
  const { store, now, setTimer, onError } = options;
  const withDrainLock = options.withDrainLock ?? ((drain) => drain());
  const listeners = new Set<() => void>();
  let snapshot: ReadonlyArray<CommandOutboxEntry<C>> = [];
  let signature = entriesSignature(snapshot);
  let disposed = false;
  const isDisposed = () => disposed;
  let cancelTimer: (() => void) | null = null;
  let activeFlush: Promise<void> | null = null;
  let flushRequested = false;
  let failedDrains = 0;

  const reload = async () => {
    const entries = [...(await store.list())].sort((left, right) => left.id - right.id);
    const nextSignature = entriesSignature(entries);
    if (nextSignature === signature) return entries;
    signature = nextSignature;
    snapshot = entries;
    for (const listener of listeners) listener();
    return entries;
  };

  const schedule = (delayMs: number) => {
    cancelTimer?.();
    cancelTimer = setTimer(
      () => {
        cancelTimer = null;
        void flush();
      },
      Math.max(0, delayMs),
    );
  };

  const deliverEntry = async (ready: CommandOutboxEntry<C>) => {
    const commandId = ready.command.commandId;
    const delivering = await store.update(ready.id, (entry) =>
      entry.command.commandId === commandId && isDue(entry, now())
        ? {
            ...entry,
            state: {
              _tag: "Delivering",
              attempt: entry.state._tag === "Retrying" ? entry.state.attempt + 1 : 1,
              startedAt: now(),
            },
          }
        : undefined,
    );
    if (!delivering) return;
    await reload();

    const record = async (command: C) => {
      await store.update(ready.id, (entry) =>
        entry.state._tag === "Delivering" && entry.command.commandId === command.commandId
          ? { ...entry, command }
          : undefined,
      );
    };
    let failure: CommandOutboxFailure | null = null;
    try {
      await options.deliver(delivering, record);
    } catch (error) {
      failure = classifyCommandDeliveryFailure(error);
    }

    if (failure === null) {
      // Acceptance is final whatever happened to the entry meanwhile.
      await store.update(ready.id, (entry) =>
        entry.command.commandId === commandId ? null : undefined,
      );
      return;
    }
    const failed = await store.update(ready.id, (entry) => {
      if (entry.state._tag !== "Delivering" || entry.command.commandId !== commandId) {
        return undefined;
      }
      const { attempt } = entry.state;
      return {
        ...entry,
        state:
          failure.classification === "permanent"
            ? { _tag: "Rejected", attempt, failure }
            : {
                _tag: "Retrying",
                attempt,
                retryAt: now() + commandOutboxRetryDelayMs(attempt),
                failure,
              },
      };
    });
    if (failed?.state._tag === "Rejected") options.onRejected?.(failed);
  };

  const drain = async () => {
    for (const entry of await store.list()) {
      if (entry.state._tag !== "Delivering") continue;
      await store.update(entry.id, (current) =>
        current.state._tag === "Delivering"
          ? {
              ...current,
              state: {
                _tag: "Retrying",
                attempt: current.state.attempt,
                retryAt: now(),
                failure: {
                  classification: "ambiguous",
                  message: "Sending stopped before the environment replied.",
                },
              },
            }
          : undefined,
      );
    }
    for (;;) {
      if (disposed) return;
      const entries = await reload();
      const ready = readyCommandOutboxEntries(entries, now()).find((entry) =>
        options.canDeliver(entry.command),
      );
      if (ready === undefined) {
        const retryAt = nextRetryAt(entries, options.canDeliver);
        if (retryAt !== null) schedule(retryAt - now());
        return;
      }
      await deliverEntry(ready);
    }
  };

  const flush = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    flushRequested = true;
    if (activeFlush !== null) return activeFlush;
    activeFlush = (async () => {
      try {
        do {
          flushRequested = false;
          try {
            await withDrainLock(drain);
            failedDrains = 0;
          } catch (error) {
            onError(error);
            failedDrains += 1;
            schedule(commandOutboxRetryDelayMs(failedDrains));
            return;
          }
        } while (flushRequested && !isDisposed());
      } finally {
        // Cleared in the same step as the last check, so a request arriving
        // now starts a new flush instead of joining one that already ended.
        activeFlush = null;
      }
    })();
    return activeFlush;
  };

  const mutate = async <A>(task: () => Promise<A>): Promise<A> => {
    const result = await task();
    await reload();
    void flush();
    return result;
  };

  void reload()
    .then(() => flush())
    .catch(onError);

  return {
    entries: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    enqueue: (command, enqueueOptions) =>
      mutate(() =>
        store.add({
          enqueuedAt: now(),
          command,
          state: enqueueOptions?.acknowledgementLost
            ? {
                _tag: "Retrying",
                attempt: 1,
                retryAt: now(),
                failure: {
                  classification: "ambiguous",
                  message: "The connection dropped before the environment replied.",
                },
              }
            : { _tag: "Pending" },
        }),
      ),
    discard: (id) =>
      mutate(async () => {
        const removed: Array<CommandOutboxEntry<C>> = [];
        await store.update(id, (entry) => {
          if (!canDiscardCommandOutboxEntry(entry)) return undefined;
          removed.push(entry);
          return null;
        });
        return removed[0] ?? null;
      }),
    retry: (id, freshCommandId) =>
      mutate(async () => {
        await store.update(id, (entry) => {
          if (entry.state._tag === "Retrying") {
            return { ...entry, state: { ...entry.state, retryAt: now() } };
          }
          if (entry.state._tag !== "Rejected") return undefined;
          return {
            ...entry,
            command: Object.assign({}, entry.command, { commandId: freshCommandId }),
            state: { _tag: "Pending" },
          };
        });
      }),
    settle: (delivered) =>
      mutate(async () => {
        for (const entry of await store.list()) {
          if (entry.state._tag === "Delivering" || !delivered(entry.command)) continue;
          await store.update(entry.id, (current) =>
            current.state._tag !== "Delivering" &&
            current.command.commandId === entry.command.commandId
              ? null
              : undefined,
          );
        }
      }),
    refresh: () => mutate(async () => undefined),
    wake: () => {
      cancelTimer?.();
      cancelTimer = null;
      return flush();
    },
    dispose: () => {
      disposed = true;
      cancelTimer?.();
      cancelTimer = null;
      listeners.clear();
    },
  };
}
