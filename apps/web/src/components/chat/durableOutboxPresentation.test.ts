import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { CommandOutboxState } from "@t3tools/client-runtime/state/command-outbox";
import { describe, expect, it } from "vite-plus/test";

import type { DurableComposerEntry } from "../../durableCommandOutbox";
import { presentDurableOutboxEntries, retryCountdownText } from "./durableOutboxPresentation";

function entry(id: number, text: string, state: CommandOutboxState): DurableComposerEntry {
  return {
    id,
    enqueuedAt: 0,
    state,
    command: {
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
      commandId: CommandId.make(`command-${id}`),
      messageId: MessageId.make(`message-${id}`),
      createdAt: "2026-10-05T10:00:00.000Z",
      text,
      attachments: [],
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      dispatchMode: "auto",
      titleSeed: text,
    },
  };
}

describe("presentDurableOutboxEntries", () => {
  it("tells offline users the message is saved and later messages wait their turn", () => {
    const views = presentDurableOutboxEntries(
      [entry(1, "first\nsecond line", { _tag: "Pending" }), entry(2, "next", { _tag: "Pending" })],
      false,
    );
    expect(views.map((view) => [view.preview, view.status, view.canTakeBack])).toEqual([
      ["first", "Saved on this device. Sends when the connection is back.", true],
      ["next", "Sends after the message above.", true],
    ]);
  });

  it("keeps a message that may have arrived out of reach of edit and discard", () => {
    const [view] = presentDurableOutboxEntries(
      [
        entry(1, "hello", {
          _tag: "Retrying",
          attempt: 1,
          retryAt: 5_000,
          failure: { classification: "ambiguous", message: "Socket closed" },
        }),
      ],
      true,
    );
    expect(view).toMatchObject({ canTakeBack: false, retryAt: 5_000, retryLabel: "Retry now" });
  });

  it("offers retry, edit and discard for a rejected message", () => {
    const [view] = presentDurableOutboxEntries(
      [
        entry(1, "hello", {
          _tag: "Rejected",
          attempt: 2,
          failure: { classification: "permanent", message: "Thread was deleted." },
        }),
      ],
      true,
    );
    expect(view).toMatchObject({
      status: "Not delivered: Thread was deleted.",
      rejected: true,
      canTakeBack: true,
      retryLabel: "Retry",
    });
  });
});

describe("retryCountdownText", () => {
  it("counts whole seconds down to the next attempt", () => {
    expect(retryCountdownText(4_200, 1_000)).toBe("Retrying in 4s");
    expect(retryCountdownText(1_000, 1_000)).toBe("Retrying");
    expect(retryCountdownText(null, 1_000)).toBeNull();
  });
});
