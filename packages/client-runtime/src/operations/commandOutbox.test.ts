import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  decodeDurableCommandOutboxDocument,
  EMPTY_DURABLE_COMMAND_OUTBOX_DOCUMENT,
  encodeDurableCommandOutboxDocument,
  makeDurableCommandDeliveryPlan,
} from "./commandOutbox.ts";

function startCommand(commandId = "command-1") {
  return {
    type: "thread.turn.start" as const,
    commandId: CommandId.make(commandId),
    threadId: ThreadId.make("thread-1"),
    message: {
      messageId: MessageId.make("message-1"),
      role: "user" as const,
      text: "Hello",
      attachments: [],
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: "2026-07-15T10:00:00.000Z",
  };
}

describe("durable command outbox model", () => {
  it("creates a deeply frozen delivery plan", () => {
    const plan = makeDurableCommandDeliveryPlan({
      environmentId: EnvironmentId.make("environment-1"),
      enqueuedAt: "2026-07-15T10:00:00.000Z",
      command: startCommand(),
    });

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.command)).toBe(true);
    expect(Object.isFrozen(plan.command.message)).toBe(true);
    expect(plan.command.commandId).toBe("command-1");
  });

  it("round-trips the versioned document", () => {
    const document = decodeDurableCommandOutboxDocument({
      schemaVersion: 1,
      entries: [
        {
          plan: {
            schemaVersion: 1,
            environmentId: "environment-1",
            enqueuedAt: "2026-07-15T10:00:00.000Z",
            command: startCommand(),
          },
          state: { _tag: "Pending" },
        },
      ],
    });

    expect(
      decodeDurableCommandOutboxDocument(encodeDurableCommandOutboxDocument(document)),
    ).toEqual(document);
  });

  it("rejects commands outside the audited replay allowlist", () => {
    expect(() =>
      decodeDurableCommandOutboxDocument({
        schemaVersion: 1,
        entries: [
          {
            plan: {
              schemaVersion: 1,
              environmentId: "environment-1",
              enqueuedAt: "2026-07-15T10:00:00.000Z",
              command: {
                type: "thread.turn.interrupt",
                commandId: "unsafe-command",
                threadId: "thread-1",
                createdAt: "2026-07-15T10:00:00.000Z",
              },
            },
            state: { _tag: "Pending" },
          },
        ],
      }),
    ).toThrow(/Only audited thread message commands/);
  });

  it("rejects duplicate identities and non-canonical lifecycle timestamps", () => {
    const entry = {
      plan: {
        schemaVersion: 1,
        environmentId: "environment-1",
        enqueuedAt: "2026-07-15T10:00:00.000Z",
        command: startCommand(),
      },
      state: { _tag: "Pending" },
    };
    expect(() =>
      decodeDurableCommandOutboxDocument({ schemaVersion: 1, entries: [entry, entry] }),
    ).toThrow(/Command identities must be unique/);
    expect(() =>
      decodeDurableCommandOutboxDocument({
        schemaVersion: 1,
        entries: [{ ...entry, plan: { ...entry.plan, enqueuedAt: "2026-99-15T10:00:00.000Z" } }],
      }),
    ).toThrow(/canonical UTC timestamp/);
  });

  it("provides a frozen empty document", () => {
    expect(EMPTY_DURABLE_COMMAND_OUTBOX_DOCUMENT).toEqual({ schemaVersion: 1, entries: [] });
    expect(Object.isFrozen(EMPTY_DURABLE_COMMAND_OUTBOX_DOCUMENT.entries)).toBe(true);
  });
});
