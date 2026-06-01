import { MessageId, TurnId, type OrchestrationMessage } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import { selectMissingStoredThreadMessages } from "./codexStoredThreadSync.ts";
import type { ProviderStoredThreadMessage } from "./Services/ProviderAdapter.ts";

const timestamp = "2026-01-01T00:00:00.000Z";

function storedMessage(
  input: Pick<ProviderStoredThreadMessage, "messageId" | "role" | "text"> &
    Partial<Pick<ProviderStoredThreadMessage, "turnId">>,
): ProviderStoredThreadMessage {
  return {
    messageId: input.messageId,
    role: input.role,
    text: input.text,
    turnId: input.turnId ?? TurnId.make("turn-1"),
    streaming: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function projectedMessage(
  input: Pick<OrchestrationMessage, "id" | "role" | "text"> &
    Partial<Pick<OrchestrationMessage, "turnId">>,
): OrchestrationMessage {
  return {
    id: input.id,
    role: input.role,
    text: input.text,
    turnId: input.turnId ?? null,
    streaming: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

it("selects only stored Codex messages not already represented in T3", () => {
  const missing = selectMissingStoredThreadMessages(
    [
      storedMessage({
        messageId: MessageId.make("codex:thread:user-1"),
        role: "user",
        text: "Already imported by provider id",
      }),
      storedMessage({
        messageId: MessageId.make("codex:thread:user-2"),
        role: "user",
        text: "Already present from T3",
      }),
      storedMessage({
        messageId: MessageId.make("assistant:item-3"),
        role: "assistant",
        text: "New Codex reply",
      }),
    ],
    [
      projectedMessage({
        id: MessageId.make("codex:thread:user-1"),
        role: "user",
        text: "Already imported by provider id",
      }),
      projectedMessage({
        id: MessageId.make("local-user-message"),
        role: "user",
        text: "Already present from T3",
      }),
    ],
  );

  expect(missing.map((message) => message.messageId)).toEqual([MessageId.make("assistant:item-3")]);
});

it("preserves repeated same-text messages by comparing occurrence counts", () => {
  const missing = selectMissingStoredThreadMessages(
    [
      storedMessage({
        messageId: MessageId.make("codex:thread:user-1"),
        role: "user",
        text: "Again",
      }),
      storedMessage({
        messageId: MessageId.make("codex:thread:user-2"),
        role: "user",
        text: "Again",
      }),
    ],
    [
      projectedMessage({
        id: MessageId.make("local-user-message"),
        role: "user",
        text: "Again",
      }),
    ],
  );

  expect(missing.map((message) => message.messageId)).toEqual([
    MessageId.make("codex:thread:user-2"),
  ]);
});
