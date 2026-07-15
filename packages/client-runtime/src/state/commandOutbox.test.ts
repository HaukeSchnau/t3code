import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

import {
  decodeDurableCommandOutboxDocument,
  EMPTY_DURABLE_COMMAND_OUTBOX_DOCUMENT,
  makeDurableCommandDeliveryPlan,
  type DurableCommandOutboxDocument,
} from "../operations/commandOutbox.ts";
import { CommandOutboxStorage, CommandOutboxStorageError } from "../platform/commandOutbox.ts";
import {
  classifyCommandDeliveryFailure,
  commandOutboxRetryDelayMs,
  CommandOutboxStateError,
  makeCommandOutbox,
} from "./commandOutbox.ts";

const T0 = "2026-07-15T10:00:00.000Z";
const T1 = "2026-07-15T10:00:01.000Z";
const T2 = "2026-07-15T10:00:02.000Z";

function plan(input: {
  readonly commandId: string;
  readonly threadId?: string;
  readonly environmentId?: string;
  readonly enqueuedAt?: string;
  readonly text?: string;
}) {
  return makeDurableCommandDeliveryPlan({
    environmentId: EnvironmentId.make(input.environmentId ?? "environment-1"),
    enqueuedAt: input.enqueuedAt ?? T0,
    command: {
      type: "thread.turn.start",
      commandId: CommandId.make(input.commandId),
      threadId: ThreadId.make(input.threadId ?? "thread-1"),
      message: {
        messageId: MessageId.make(`message-${input.commandId}`),
        role: "user",
        text: input.text ?? input.commandId,
        attachments: [],
      },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: T0,
    },
  });
}

function commandIds(document: DurableCommandOutboxDocument) {
  return document.entries.map((entry) => entry.plan.command.commandId);
}

function entryIds(
  entries: ReadonlyArray<{ readonly plan: { readonly command: { readonly commandId: string } } }>,
) {
  return entries.map((entry) => entry.plan.command.commandId);
}

function makeStorage(initial = EMPTY_DURABLE_COMMAND_OUTBOX_DOCUMENT) {
  let persisted: DurableCommandOutboxDocument = initial;
  let saveError: CommandOutboxStorageError | null = null;
  const saves: DurableCommandOutboxDocument[] = [];
  const storage = CommandOutboxStorage.of({
    load: Effect.sync(() => persisted),
    save: (document) =>
      saveError === null
        ? Effect.sync(() => {
            persisted = document;
            saves.push(document);
          })
        : Effect.fail(saveError),
  });
  return {
    storage,
    saves,
    persisted: () => persisted,
    failSaves: () => {
      saveError = new CommandOutboxStorageError({
        operation: "save",
        message: "disk full",
      });
    },
  };
}

describe("command outbox lifecycle", () => {
  it.effect("persists before publishing an enqueued command", () =>
    Effect.gen(function* () {
      const harness = makeStorage();
      const outbox = yield* makeCommandOutbox(harness.storage, T0);
      harness.failSaves();

      const error = yield* Effect.flip(outbox.enqueue(plan({ commandId: "command-1" })));

      expect(error._tag).toBe("CommandOutboxStorageError");
      expect(yield* outbox.entries).toEqual([]);
      expect(harness.persisted()).toEqual(EMPTY_DURABLE_COMMAND_OUTBOX_DOCUMENT);
    }),
  );

  it.effect("cannot be interrupted between an async durable save and memory publication", () =>
    Effect.gen(function* () {
      let persisted = EMPTY_DURABLE_COMMAND_OUTBOX_DOCUMENT;
      let firstSave = true;
      let completeFirstSave: (() => void) | undefined;
      const firstSaveCommitted = yield* Deferred.make<void>();
      const storage = CommandOutboxStorage.of({
        load: Effect.sync(() => persisted),
        save: (document) => {
          if (!firstSave) {
            return Effect.sync(() => {
              persisted = document;
            });
          }
          firstSave = false;
          return Effect.callback<void>((resume) => {
            persisted = document;
            Deferred.doneUnsafe(firstSaveCommitted, Effect.void);
            completeFirstSave = () => resume(Effect.void);
          });
        },
      });
      const outbox = yield* makeCommandOutbox(storage, T0);
      const firstEnqueue = yield* outbox
        .enqueue(plan({ commandId: "first" }))
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* Deferred.await(firstSaveCommitted);
      const interrupted = yield* Effect.sync(() => {
        if (completeFirstSave === undefined) {
          throw new Error("Expected the controlled async save to be waiting for completion");
        }
        firstEnqueue.interruptUnsafe();
        completeFirstSave();
      }).pipe(Effect.andThen(Fiber.await(firstEnqueue)));

      expect(Exit.hasInterrupts(interrupted)).toBe(true);
      expect((yield* outbox.entries).map((entry) => entry.plan.command.commandId)).toEqual([
        "first",
      ]);
      expect(persisted.entries.map((entry) => entry.plan.command.commandId)).toEqual(["first"]);

      yield* outbox.enqueue(plan({ commandId: "second" }));
      expect((yield* outbox.entries).map((entry) => entry.plan.command.commandId)).toEqual([
        "first",
        "second",
      ]);
      expect(persisted.entries.map((entry) => entry.plan.command.commandId)).toEqual([
        "first",
        "second",
      ]);
    }),
  );

  it.effect("offers only each thread head while allowing independent threads", () =>
    Effect.gen(function* () {
      const harness = makeStorage();
      const outbox = yield* makeCommandOutbox(harness.storage, T0);
      yield* outbox.enqueue(plan({ commandId: "a1", threadId: "thread-a" }));
      yield* outbox.enqueue(plan({ commandId: "a2", threadId: "thread-a" }));
      yield* outbox.enqueue(plan({ commandId: "b1", threadId: "thread-b" }));

      expect((yield* outbox.ready(T0)).map((entry) => entry.plan.command.commandId)).toEqual([
        "a1",
        "b1",
      ]);

      yield* outbox.begin(CommandId.make("a1"), T0);
      expect((yield* outbox.ready(T0)).map((entry) => entry.plan.command.commandId)).toEqual([
        "b1",
      ]);
    }),
  );

  it.effect("retries transient and ambiguous failures with the same identity", () =>
    Effect.gen(function* () {
      const outbox = yield* makeCommandOutbox(makeStorage().storage, T0);
      yield* outbox.enqueue(plan({ commandId: "command-1" }));
      const first = yield* outbox.begin(CommandId.make("command-1"), T0);
      expect(first.state).toMatchObject({ _tag: "Delivering", attempt: 1 });

      const retrying = yield* outbox.fail(
        CommandId.make("command-1"),
        { classification: "ambiguous", message: "ack lost" },
        T0,
      );
      expect(retrying.state).toMatchObject({
        _tag: "Retrying",
        attempt: 1,
        retryNotBefore: T1,
      });
      expect(yield* outbox.ready("2026-07-15T10:00:00.999Z")).toEqual([]);

      const second = yield* outbox.begin(CommandId.make("command-1"), T1);
      expect(second.plan.command.commandId).toBe("command-1");
      expect(second.state).toMatchObject({ _tag: "Delivering", attempt: 2 });
      yield* outbox.complete(CommandId.make("command-1"));
      expect(yield* outbox.entries).toEqual([]);
    }),
  );

  it.effect("a permanent head failure blocks only its thread", () =>
    Effect.gen(function* () {
      const outbox = yield* makeCommandOutbox(makeStorage().storage, T0);
      yield* outbox.enqueue(plan({ commandId: "a1", threadId: "thread-a" }));
      yield* outbox.enqueue(plan({ commandId: "a2", threadId: "thread-a" }));
      yield* outbox.enqueue(plan({ commandId: "b1", threadId: "thread-b" }));
      yield* outbox.begin(CommandId.make("a1"), T0);
      yield* outbox.fail(
        CommandId.make("a1"),
        { classification: "permanent", message: "invalid request" },
        T0,
      );

      expect((yield* outbox.ready(T2)).map((entry) => entry.plan.command.commandId)).toEqual([
        "b1",
      ]);
    }),
  );

  it.effect("edit-and-retry requires a new identity and preserves FIFO position", () =>
    Effect.gen(function* () {
      const outbox = yield* makeCommandOutbox(makeStorage().storage, T0);
      yield* outbox.enqueue(plan({ commandId: "old" }));
      yield* outbox.enqueue(plan({ commandId: "later", enqueuedAt: T1 }));
      yield* outbox.begin(CommandId.make("old"), T0);
      yield* outbox.fail(
        CommandId.make("old"),
        { classification: "permanent", message: "rejected" },
        T0,
      );

      const reused = yield* Effect.flip(
        outbox.replaceRejected(CommandId.make("old"), plan({ commandId: "old" })),
      );
      expect(reused).toBeInstanceOf(CommandOutboxStateError);
      expect(reused).toMatchObject({ reason: "replacement-identity-reused" });

      yield* outbox.replaceRejected(
        CommandId.make("old"),
        plan({ commandId: "replacement", enqueuedAt: T2 }),
      );
      expect((yield* outbox.ready(T2)).map((entry) => entry.plan.command.commandId)).toEqual([
        "replacement",
      ]);
    }),
  );

  it.effect("rejects removing non-rejected entries without disturbing per-thread FIFO", () =>
    Effect.gen(function* () {
      const outbox = yield* makeCommandOutbox(makeStorage().storage, T0);
      for (const [head, successor, threadId] of [
        ["pending", "pending-next", "thread-pending"],
        ["delivering", "delivering-next", "thread-delivering"],
        ["transient", "transient-next", "thread-transient"],
        ["ambiguous", "ambiguous-next", "thread-ambiguous"],
      ] as const) {
        yield* outbox.enqueue(plan({ commandId: head, threadId }));
        yield* outbox.enqueue(plan({ commandId: successor, threadId }));
      }
      yield* outbox.begin(CommandId.make("delivering"), T0);
      yield* outbox.begin(CommandId.make("transient"), T0);
      yield* outbox.fail(
        CommandId.make("transient"),
        { classification: "transient", message: "offline" },
        T0,
      );
      yield* outbox.begin(CommandId.make("ambiguous"), T0);
      yield* outbox.fail(
        CommandId.make("ambiguous"),
        { classification: "ambiguous", message: "ack lost" },
        T0,
      );

      for (const commandId of ["pending", "delivering", "transient", "ambiguous"]) {
        const error = yield* Effect.flip(outbox.removeRejected(CommandId.make(commandId)));
        expect(error).toMatchObject({
          _tag: "CommandOutboxStateError",
          reason: "invalid-transition",
        });
      }

      expect((yield* outbox.entries).map((entry) => entry.plan.command.commandId)).toEqual([
        "pending",
        "pending-next",
        "delivering",
        "delivering-next",
        "transient",
        "transient-next",
        "ambiguous",
        "ambiguous-next",
      ]);
      expect((yield* outbox.ready(T2)).map((entry) => entry.plan.command.commandId)).toEqual([
        "pending",
        "transient",
        "ambiguous",
      ]);
    }),
  );

  it.effect("removing a rejected head unblocks its successor", () =>
    Effect.gen(function* () {
      const outbox = yield* makeCommandOutbox(makeStorage().storage, T0);
      yield* outbox.enqueue(plan({ commandId: "first" }));
      yield* outbox.enqueue(plan({ commandId: "second" }));
      yield* outbox.begin(CommandId.make("first"), T0);
      yield* outbox.fail(
        CommandId.make("first"),
        { classification: "permanent", message: "rejected" },
        T0,
      );
      yield* outbox.removeRejected(CommandId.make("first"));

      expect((yield* outbox.ready(T0))[0]?.plan.command.commandId).toBe("second");
    }),
  );

  it.effect("recovers an interrupted delivery as an immediate ambiguous retry", () =>
    Effect.gen(function* () {
      const initial = decodeDurableCommandOutboxDocument({
        schemaVersion: 1,
        entries: [
          {
            plan: plan({ commandId: "command-1" }),
            state: { _tag: "Delivering", attempt: 3, startedAt: T0 },
          },
        ],
      });
      const harness = makeStorage(initial);
      const outbox = yield* makeCommandOutbox(harness.storage, T2);
      const [recovered] = yield* outbox.entries;

      expect(recovered?.state).toMatchObject({
        _tag: "Retrying",
        attempt: 3,
        retryNotBefore: T2,
        failure: { classification: "ambiguous", failedAt: T2 },
      });
      expect((yield* outbox.ready(T2))[0]?.plan.command.commandId).toBe("command-1");
      expect(harness.saves).toHaveLength(1);
    }),
  );

  it.effect("rejects duplicate identities and invalid transitions", () =>
    Effect.gen(function* () {
      const outbox = yield* makeCommandOutbox(makeStorage().storage, T0);
      yield* outbox.enqueue(plan({ commandId: "command-1" }));

      const duplicate = yield* Effect.flip(outbox.enqueue(plan({ commandId: "command-1" })));
      expect(duplicate).toMatchObject({
        _tag: "CommandOutboxStateError",
        reason: "duplicate-command",
      });

      const completePending = yield* Effect.flip(outbox.complete(CommandId.make("command-1")));
      expect(completePending).toMatchObject({
        _tag: "CommandOutboxStateError",
        reason: "invalid-transition",
      });
    }),
  );
});

describe("pending command edits and cancellation", () => {
  it.effect("cancels only pending entries and rejects every attempted lifecycle", () =>
    Effect.gen(function* () {
      const harness = makeStorage();
      const outbox = yield* makeCommandOutbox(harness.storage, T0);
      for (const [commandId, threadId] of [
        ["pending", "thread-pending"],
        ["delivering", "thread-delivering"],
        ["retrying", "thread-retrying"],
        ["rejected", "thread-rejected"],
      ] as const) {
        yield* outbox.enqueue(plan({ commandId, threadId }));
      }
      yield* outbox.begin(CommandId.make("delivering"), T0);
      yield* outbox.begin(CommandId.make("retrying"), T0);
      yield* outbox.fail(
        CommandId.make("retrying"),
        { classification: "ambiguous", message: "ack lost" },
        T0,
      );
      yield* outbox.begin(CommandId.make("rejected"), T0);
      yield* outbox.fail(
        CommandId.make("rejected"),
        { classification: "permanent", message: "invalid" },
        T0,
      );

      for (const commandId of ["delivering", "retrying", "rejected"]) {
        const error = yield* Effect.flip(outbox.cancelPending(CommandId.make(commandId)));
        expect(error).toMatchObject({
          _tag: "CommandOutboxStateError",
          reason: "invalid-transition",
        });
      }
      yield* outbox.cancelPending(CommandId.make("pending"));

      expect(entryIds(yield* outbox.entries)).toEqual(["delivering", "retrying", "rejected"]);
      expect(commandIds(harness.persisted())).toEqual(["delivering", "retrying", "rejected"]);
      const missing = yield* Effect.flip(outbox.cancelPending(CommandId.make("missing")));
      expect(missing).toMatchObject({ reason: "missing-command" });
    }),
  );

  it.effect(
    "replaces only pending entries and freezes identity and payload when delivery begins",
    () =>
      Effect.gen(function* () {
        const outbox = yield* makeCommandOutbox(makeStorage().storage, T0);
        for (const [commandId, threadId] of [
          ["pending", "thread-pending"],
          ["delivering", "thread-delivering"],
          ["retrying", "thread-retrying"],
          ["rejected", "thread-rejected"],
        ] as const) {
          yield* outbox.enqueue(plan({ commandId, threadId }));
        }
        yield* outbox.begin(CommandId.make("delivering"), T0);
        yield* outbox.begin(CommandId.make("retrying"), T0);
        yield* outbox.fail(
          CommandId.make("retrying"),
          { classification: "transient", message: "offline" },
          T0,
        );
        yield* outbox.begin(CommandId.make("rejected"), T0);
        yield* outbox.fail(
          CommandId.make("rejected"),
          { classification: "permanent", message: "invalid" },
          T0,
        );

        for (const commandId of ["delivering", "retrying", "rejected"]) {
          const error = yield* Effect.flip(
            outbox.replacePending(
              CommandId.make(commandId),
              plan({ commandId: `${commandId}-replacement`, threadId: `thread-${commandId}` }),
            ),
          );
          expect(error).toMatchObject({
            _tag: "CommandOutboxStateError",
            reason: "invalid-transition",
          });
        }

        const replacement = yield* outbox.replacePending(
          CommandId.make("pending"),
          plan({ commandId: "replacement", threadId: "thread-pending", text: "edited" }),
        );
        expect(replacement).toMatchObject({
          plan: { command: { commandId: "replacement", message: { text: "edited" } } },
          state: { _tag: "Pending" },
        });

        const delivering = yield* outbox.begin(CommandId.make("replacement"), T0);
        expect(Object.isFrozen(delivering.plan)).toBe(true);
        expect(Object.isFrozen(delivering.plan.command)).toBe(true);
        expect(Object.isFrozen(delivering.plan.command.message)).toBe(true);
        expect(Reflect.set(delivering.plan.command.message, "text", "mutated after begin")).toBe(
          false,
        );
        expect(delivering.plan.command.message.text).toBe("edited");

        const afterBegin = yield* Effect.flip(
          outbox.replacePending(
            CommandId.make("replacement"),
            plan({ commandId: "too-late", threadId: "thread-pending" }),
          ),
        );
        expect(afterBegin).toMatchObject({ reason: "invalid-transition" });
      }),
  );

  it.effect("rejects same and duplicate replacement IDs without publishing changes", () =>
    Effect.gen(function* () {
      const harness = makeStorage();
      const outbox = yield* makeCommandOutbox(harness.storage, T0);
      yield* outbox.enqueue(plan({ commandId: "editable", text: "before" }));
      yield* outbox.enqueue(plan({ commandId: "occupied", threadId: "thread-2" }));
      const beforeSameId = harness.persisted();
      const savesBeforeSameId = harness.saves.length;

      const sameId = yield* Effect.flip(
        outbox.replacePending(
          CommandId.make("editable"),
          plan({ commandId: "editable", text: "after" }),
        ),
      );
      expect(sameId).toMatchObject({
        reason: "replacement-identity-reused",
        commandId: "editable",
      });
      expect(harness.persisted()).toBe(beforeSameId);
      expect(harness.saves).toHaveLength(savesBeforeSameId);
      expect((yield* outbox.entries)[0]?.plan.command.message.text).toBe("before");

      const duplicate = yield* Effect.flip(
        outbox.replacePending(CommandId.make("editable"), plan({ commandId: "occupied" })),
      );
      expect(duplicate).toMatchObject({ reason: "duplicate-command", commandId: "occupied" });

      const changedThread = yield* Effect.flip(
        outbox.replacePending(
          CommandId.make("editable"),
          plan({ commandId: "new-id", threadId: "other-thread" }),
        ),
      );
      expect(changedThread).toMatchObject({ reason: "replacement-thread-changed" });

      const invalid = {
        ...plan({ commandId: "invalid" }),
        enqueuedAt: "not-a-timestamp",
      } as unknown as Parameters<typeof outbox.replacePending>[1];
      const invalidError = yield* Effect.flip(
        outbox.replacePending(CommandId.make("editable"), invalid),
      );
      expect(invalidError).toMatchObject({ reason: "invalid-replacement" });
      expect(commandIds(harness.persisted())).toEqual(["editable", "occupied"]);
      expect(entryIds(yield* outbox.entries)).toEqual(["editable", "occupied"]);
    }),
  );

  it.effect("invalidates stale ready entries and dispatches the canonical begin result", () =>
    Effect.gen(function* () {
      const outbox = yield* makeCommandOutbox(makeStorage().storage, T0);
      yield* outbox.enqueue(plan({ commandId: "old-id", text: "obsolete intent" }));
      const staleReadyEntry = (yield* outbox.ready(T0))[0]!;
      const replacementPlan = plan({ commandId: "new-id", text: "canonical replacement" });

      yield* outbox.replacePending(CommandId.make("old-id"), replacementPlan);

      const staleBegin = yield* Effect.flip(
        outbox.begin(staleReadyEntry.plan.command.commandId, T1),
      );
      expect(staleBegin).toMatchObject({ reason: "missing-command", commandId: "old-id" });

      const begun = yield* outbox.begin(CommandId.make("new-id"), T1);
      const dispatchedCommand = begun.plan.command;
      expect(begun.state).toMatchObject({ _tag: "Delivering", attempt: 1 });
      expect(dispatchedCommand).toEqual(replacementPlan.command);
      expect(dispatchedCommand).not.toBe(staleReadyEntry.plan.command);
      expect(dispatchedCommand).toMatchObject({
        commandId: "new-id",
        message: { text: "canonical replacement" },
      });
    }),
  );

  it.effect("preserves FIFO position and per-thread progress across edit and cancel", () =>
    Effect.gen(function* () {
      const outbox = yield* makeCommandOutbox(makeStorage().storage, T0);
      yield* outbox.enqueue(plan({ commandId: "a1", threadId: "thread-a" }));
      yield* outbox.enqueue(plan({ commandId: "a2", threadId: "thread-a", enqueuedAt: T1 }));
      yield* outbox.enqueue(plan({ commandId: "b1", threadId: "thread-b" }));

      yield* outbox.replacePending(
        CommandId.make("a1"),
        plan({ commandId: "a1-edited", threadId: "thread-a", enqueuedAt: T2 }),
      );
      expect(entryIds(yield* outbox.entries)).toEqual(["a1-edited", "a2", "b1"]);
      expect(entryIds(yield* outbox.ready(T2))).toEqual(["a1-edited", "b1"]);

      yield* outbox.cancelPending(CommandId.make("a1-edited"));
      expect(entryIds(yield* outbox.entries)).toEqual(["a2", "b1"]);
      expect(entryIds(yield* outbox.ready(T2))).toEqual(["a2", "b1"]);
    }),
  );

  it.effect("leaves durable and observable state unchanged when edit or cancel storage fails", () =>
    Effect.gen(function* () {
      const harness = makeStorage();
      const outbox = yield* makeCommandOutbox(harness.storage, T0);
      yield* outbox.enqueue(plan({ commandId: "editable" }));
      yield* outbox.enqueue(plan({ commandId: "cancellable", threadId: "thread-2" }));
      const before = harness.persisted();
      harness.failSaves();

      const replaceError = yield* Effect.flip(
        outbox.replacePending(CommandId.make("editable"), plan({ commandId: "replacement" })),
      );
      expect(replaceError._tag).toBe("CommandOutboxStorageError");
      const cancelError = yield* Effect.flip(outbox.cancelPending(CommandId.make("cancellable")));
      expect(cancelError._tag).toBe("CommandOutboxStorageError");

      expect(harness.persisted()).toBe(before);
      expect(entryIds(yield* outbox.entries)).toEqual(["editable", "cancellable"]);
    }),
  );

  for (const transition of ["replace", "cancel"] as const) {
    it.effect(
      `publishes an async ${transition} atomically when interruption arrives during save`,
      () =>
        Effect.gen(function* () {
          const initial = decodeDurableCommandOutboxDocument({
            schemaVersion: 1,
            entries: [{ plan: plan({ commandId: "pending" }), state: { _tag: "Pending" } }],
          });
          let persisted = initial;
          let completeSave: (() => void) | undefined;
          const saveCommitted = yield* Deferred.make<void>();
          const storage = CommandOutboxStorage.of({
            load: Effect.succeed(initial),
            save: (document) =>
              Effect.callback<void>((resume) => {
                persisted = document;
                Deferred.doneUnsafe(saveCommitted, Effect.void);
                completeSave = () => resume(Effect.void);
              }),
          });
          const outbox = yield* makeCommandOutbox(storage, T0);
          const mutation = yield* (
            transition === "replace"
              ? outbox.replacePending(CommandId.make("pending"), plan({ commandId: "replacement" }))
              : outbox.cancelPending(CommandId.make("pending"))
          ).pipe(Effect.forkChild({ startImmediately: true }));

          yield* Deferred.await(saveCommitted);
          const expected = transition === "replace" ? ["replacement"] : [];
          expect(commandIds(persisted)).toEqual(expected);
          expect(entryIds(yield* outbox.entries)).toEqual(["pending"]);

          const interrupted = yield* Effect.sync(() => {
            if (completeSave === undefined) {
              throw new Error("Expected the controlled async save to be waiting for completion");
            }
            mutation.interruptUnsafe();
            completeSave();
          }).pipe(Effect.andThen(Fiber.await(mutation)));

          expect(Exit.hasInterrupts(interrupted)).toBe(true);
          expect(commandIds(persisted)).toEqual(expected);
          expect(entryIds(yield* outbox.entries)).toEqual(expected);
        }),
    );
  }
});

describe("command outbox failure policy", () => {
  it("uses bounded exponential retry delays", () => {
    expect(commandOutboxRetryDelayMs(1)).toBe(1_000);
    expect(commandOutboxRetryDelayMs(2)).toBe(2_000);
    expect(commandOutboxRetryDelayMs(20)).toBe(16_000);
  });

  it("classifies known unavailable errors as transient and transport loss as ambiguous", () => {
    expect(
      classifyCommandDeliveryFailure({
        _tag: "EnvironmentRpcUnavailableError",
        message: "offline",
      }),
    ).toEqual({ classification: "transient", message: "offline" });
    expect(classifyCommandDeliveryFailure(new Error("SocketCloseError: lost ack"))).toEqual({
      classification: "ambiguous",
      message: "SocketCloseError: lost ack",
    });
    expect(classifyCommandDeliveryFailure(new Error("unknown failure"))).toEqual({
      classification: "ambiguous",
      message: "unknown failure",
    });
  });
});
