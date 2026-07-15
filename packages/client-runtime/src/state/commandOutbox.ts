import { CommandId, type CommandId as CommandIdType } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { isTransportConnectionErrorMessage } from "../errors/transport.ts";
import {
  decodeDurableCommandOutboxDocument,
  type CommandDeliveryFailure,
  type CommandDeliveryFailureClassification,
  type DurableCommandDeliveryPlan,
  type DurableCommandOutboxDocument,
  type DurableCommandOutboxEntry,
} from "../operations/commandOutbox.ts";
import { CommandOutboxStorage, type CommandOutboxStorageError } from "../platform/commandOutbox.ts";

const MAX_RETRY_DELAY_MS = 16_000;

export class CommandOutboxStateError extends Schema.TaggedErrorClass<CommandOutboxStateError>()(
  "CommandOutboxStateError",
  {
    reason: Schema.Literals([
      "duplicate-command",
      "missing-command",
      "invalid-transition",
      "not-ready",
      "replacement-identity-reused",
      "replacement-thread-changed",
    ]),
    commandId: Schema.NullOr(CommandId),
    message: Schema.String,
  },
) {}

export interface CommandDeliveryFailureInput {
  readonly classification: CommandDeliveryFailureClassification;
  readonly message: string;
}

export function commandOutboxRetryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), MAX_RETRY_DELAY_MS);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message;
    if (typeof message === "string") {
      return message;
    }
  }
  return typeof error === "string" ? error : "Command delivery failed";
}

/**
 * Classifies failures the shared runtime can recognize. Unknown failures are
 * ambiguous by default: retrying the frozen command identity is safer than
 * silently losing a command. Adapters should pass `permanent` explicitly for
 * typed business rejections.
 */
export function classifyCommandDeliveryFailure(
  error: unknown,
  fallback: CommandDeliveryFailureClassification = "ambiguous",
): CommandDeliveryFailureInput {
  const message = errorMessage(error);
  if (typeof error === "object" && error !== null && "_tag" in error) {
    if (
      error._tag === "EnvironmentRpcUnavailableError" ||
      error._tag === "ConnectionTransientError"
    ) {
      return { classification: "transient", message };
    }
  }
  if (isTransportConnectionErrorMessage(message)) {
    return { classification: "ambiguous", message };
  }
  return { classification: fallback, message };
}

function commandIdOf(entry: DurableCommandOutboxEntry): CommandIdType {
  return entry.plan.command.commandId;
}

function sameThread(left: DurableCommandDeliveryPlan, right: DurableCommandDeliveryPlan): boolean {
  return (
    left.environmentId === right.environmentId && left.command.threadId === right.command.threadId
  );
}

function readyEntries(
  document: DurableCommandOutboxDocument,
  at: string,
): ReadonlyArray<DurableCommandOutboxEntry> {
  const seenThreads = new Set<string>();
  const ready: DurableCommandOutboxEntry[] = [];
  for (const entry of document.entries) {
    const key = JSON.stringify([entry.plan.environmentId, entry.plan.command.threadId]);
    if (seenThreads.has(key)) {
      continue;
    }
    seenThreads.add(key);
    if (
      entry.state._tag === "Pending" ||
      (entry.state._tag === "Retrying" && entry.state.retryNotBefore <= at)
    ) {
      ready.push(entry);
    }
  }
  return ready;
}

function stateError(
  reason: CommandOutboxStateError["reason"],
  commandId: CommandIdType | null,
  message: string,
): CommandOutboxStateError {
  return new CommandOutboxStateError({ reason, commandId, message });
}

const isCommandOutboxStateError: (value: unknown) => value is CommandOutboxStateError =
  Schema.is(CommandOutboxStateError);

export interface CommandOutboxService {
  readonly entries: Effect.Effect<ReadonlyArray<DurableCommandOutboxEntry>>;
  readonly enqueue: (
    plan: DurableCommandDeliveryPlan,
  ) => Effect.Effect<
    DurableCommandOutboxEntry,
    CommandOutboxStorageError | CommandOutboxStateError
  >;
  readonly ready: (at: string) => Effect.Effect<ReadonlyArray<DurableCommandOutboxEntry>>;
  readonly begin: (
    commandId: CommandIdType,
    startedAt: string,
  ) => Effect.Effect<
    DurableCommandOutboxEntry,
    CommandOutboxStorageError | CommandOutboxStateError
  >;
  readonly complete: (
    commandId: CommandIdType,
  ) => Effect.Effect<void, CommandOutboxStorageError | CommandOutboxStateError>;
  readonly fail: (
    commandId: CommandIdType,
    failure: CommandDeliveryFailureInput,
    failedAt: string,
  ) => Effect.Effect<
    DurableCommandOutboxEntry,
    CommandOutboxStorageError | CommandOutboxStateError
  >;
  readonly remove: (
    commandId: CommandIdType,
  ) => Effect.Effect<void, CommandOutboxStorageError | CommandOutboxStateError>;
  readonly replaceRejected: (
    commandId: CommandIdType,
    replacement: DurableCommandDeliveryPlan,
  ) => Effect.Effect<
    DurableCommandOutboxEntry,
    CommandOutboxStorageError | CommandOutboxStateError
  >;
}

export class CommandOutbox extends Context.Service<CommandOutbox, CommandOutboxService>()(
  "@t3tools/client-runtime/state/commandOutbox",
) {}

function retryAt(failedAt: string, attempt: number): string {
  return DateTime.makeUnsafe(failedAt).pipe(
    DateTime.addDuration(commandOutboxRetryDelayMs(attempt)),
    DateTime.formatIso,
  );
}

export const makeCommandOutbox = Effect.fn("CommandOutbox.make")(function* (
  storage: CommandOutboxStorage["Service"],
  recoveredAt?: string,
): Effect.fn.Return<CommandOutboxService, CommandOutboxStorageError> {
  const loaded = yield* storage.load;
  const recoveryTimestamp =
    recoveredAt ?? (yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)));
  const recoveredEntries = loaded.entries.map((entry): DurableCommandOutboxEntry => {
    if (entry.state._tag !== "Delivering") {
      return entry;
    }
    return {
      plan: entry.plan,
      state: {
        _tag: "Retrying",
        attempt: entry.state.attempt,
        retryNotBefore: recoveryTimestamp,
        failure: {
          classification: "ambiguous",
          message: "Delivery was interrupted before its acknowledgement was recorded",
          failedAt: recoveryTimestamp,
        },
      },
    };
  });
  const recovered = decodeDurableCommandOutboxDocument({
    schemaVersion: 1,
    entries: recoveredEntries,
  });
  if (recoveredEntries.some((entry, index) => entry !== loaded.entries[index])) {
    yield* storage.save(recovered);
  }

  const document = yield* Ref.make(recovered);
  const mutations = yield* Semaphore.make(1);

  const persist = <A>(
    update: (
      current: DurableCommandOutboxDocument,
    ) => readonly [A, DurableCommandOutboxDocument] | CommandOutboxStateError,
  ): Effect.Effect<A, CommandOutboxStorageError | CommandOutboxStateError> =>
    mutations.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(document);
        const result = update(current);
        if (isCommandOutboxStateError(result)) {
          return yield* result;
        }
        const [value, nextInput] = result;
        const next = decodeDurableCommandOutboxDocument(nextInput);
        yield* storage.save(next);
        yield* Ref.set(document, next);
        return value;
      }),
    );

  const enqueue = Effect.fn("CommandOutbox.enqueue")(function* (plan: DurableCommandDeliveryPlan) {
    return yield* persist((current) => {
      const commandId = plan.command.commandId;
      if (current.entries.some((entry) => commandIdOf(entry) === commandId)) {
        return stateError(
          "duplicate-command",
          commandId,
          `Command ${commandId} is already present in the outbox`,
        );
      }
      const entry: DurableCommandOutboxEntry = { plan, state: { _tag: "Pending" } };
      return [entry, { ...current, entries: [...current.entries, entry] }] as const;
    });
  });

  const ready = Effect.fn("CommandOutbox.ready")(function* (at: string) {
    return readyEntries(yield* Ref.get(document), at);
  });

  const begin = Effect.fn("CommandOutbox.begin")(function* (
    commandId: CommandIdType,
    startedAt: string,
  ) {
    return yield* persist((current) => {
      const index = current.entries.findIndex((entry) => commandIdOf(entry) === commandId);
      if (index < 0) {
        return stateError("missing-command", commandId, `Command ${commandId} is not queued`);
      }
      const entry = current.entries[index]!;
      if (
        !readyEntries(current, startedAt).some((candidate) => commandIdOf(candidate) === commandId)
      ) {
        return stateError("not-ready", commandId, `Command ${commandId} is not ready for delivery`);
      }
      const attempt = entry.state._tag === "Retrying" ? entry.state.attempt + 1 : 1;
      const nextEntry: DurableCommandOutboxEntry = {
        plan: entry.plan,
        state: { _tag: "Delivering", attempt, startedAt },
      };
      const entries = [...current.entries];
      entries[index] = nextEntry;
      return [nextEntry, { ...current, entries }] as const;
    });
  });

  const complete = Effect.fn("CommandOutbox.complete")(function* (commandId: CommandIdType) {
    return yield* persist((current) => {
      const entry = current.entries.find((candidate) => commandIdOf(candidate) === commandId);
      if (entry === undefined) {
        return stateError("missing-command", commandId, `Command ${commandId} is not queued`);
      }
      if (entry.state._tag !== "Delivering") {
        return stateError(
          "invalid-transition",
          commandId,
          `Command ${commandId} is not being delivered`,
        );
      }
      return [
        undefined,
        {
          ...current,
          entries: current.entries.filter((candidate) => commandIdOf(candidate) !== commandId),
        },
      ] as const;
    });
  });

  const fail = Effect.fn("CommandOutbox.fail")(function* (
    commandId: CommandIdType,
    input: CommandDeliveryFailureInput,
    failedAt: string,
  ) {
    return yield* persist((current) => {
      const index = current.entries.findIndex((entry) => commandIdOf(entry) === commandId);
      if (index < 0) {
        return stateError("missing-command", commandId, `Command ${commandId} is not queued`);
      }
      const entry = current.entries[index]!;
      if (entry.state._tag !== "Delivering") {
        return stateError(
          "invalid-transition",
          commandId,
          `Command ${commandId} is not being delivered`,
        );
      }
      const failure: CommandDeliveryFailure = { ...input, failedAt };
      const state =
        input.classification === "permanent"
          ? ({ _tag: "Rejected", attempt: entry.state.attempt, failure } as const)
          : ({
              _tag: "Retrying",
              attempt: entry.state.attempt,
              retryNotBefore: retryAt(failedAt, entry.state.attempt),
              failure,
            } as const);
      const nextEntry: DurableCommandOutboxEntry = { plan: entry.plan, state };
      const entries = [...current.entries];
      entries[index] = nextEntry;
      return [nextEntry, { ...current, entries }] as const;
    });
  });

  const remove = Effect.fn("CommandOutbox.remove")(function* (commandId: CommandIdType) {
    return yield* persist((current) => {
      const entry = current.entries.find((candidate) => commandIdOf(candidate) === commandId);
      if (entry === undefined) {
        return stateError("missing-command", commandId, `Command ${commandId} is not queued`);
      }
      if (entry.state._tag === "Delivering") {
        return stateError(
          "invalid-transition",
          commandId,
          `Command ${commandId} cannot be removed while delivery is in progress`,
        );
      }
      return [
        undefined,
        {
          ...current,
          entries: current.entries.filter((candidate) => commandIdOf(candidate) !== commandId),
        },
      ] as const;
    });
  });

  const replaceRejected = Effect.fn("CommandOutbox.replaceRejected")(function* (
    commandId: CommandIdType,
    replacement: DurableCommandDeliveryPlan,
  ) {
    return yield* persist((current) => {
      const index = current.entries.findIndex((entry) => commandIdOf(entry) === commandId);
      if (index < 0) {
        return stateError("missing-command", commandId, `Command ${commandId} is not queued`);
      }
      const previous = current.entries[index]!;
      if (previous.state._tag !== "Rejected") {
        return stateError(
          "invalid-transition",
          commandId,
          `Command ${commandId} has not been permanently rejected`,
        );
      }
      if (replacement.command.commandId === commandId) {
        return stateError(
          "replacement-identity-reused",
          commandId,
          "Editing or retrying a rejected command requires a new command identity",
        );
      }
      if (!sameThread(previous.plan, replacement)) {
        return stateError(
          "replacement-thread-changed",
          replacement.command.commandId,
          "A rejected command replacement must remain in the same environment and thread",
        );
      }
      if (current.entries.some((entry) => commandIdOf(entry) === replacement.command.commandId)) {
        return stateError(
          "duplicate-command",
          replacement.command.commandId,
          `Command ${replacement.command.commandId} is already present in the outbox`,
        );
      }
      const nextEntry: DurableCommandOutboxEntry = {
        plan: replacement,
        state: { _tag: "Pending" },
      };
      const entries = [...current.entries];
      entries[index] = nextEntry;
      return [nextEntry, { ...current, entries }] as const;
    });
  });

  return CommandOutbox.of({
    entries: Ref.get(document).pipe(Effect.map((current) => current.entries)),
    enqueue,
    ready,
    begin,
    complete,
    fail,
    remove,
    replaceRejected,
  });
});

export const CommandOutboxLive = Layer.effect(
  CommandOutbox,
  CommandOutboxStorage.pipe(Effect.flatMap((storage) => makeCommandOutbox(storage))),
);
