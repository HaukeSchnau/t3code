import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

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
        text: input.commandId,
        attachments: [],
      },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: T0,
    },
  });
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

  it.effect("removing a failed head unblocks its successor", () =>
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
      yield* outbox.remove(CommandId.make("first"));

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
