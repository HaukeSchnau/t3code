import type { DurableCommandOutboxEntry } from "@t3tools/client-runtime/operations/command-outbox";
import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  localRetryCountdownText,
  presentDurableOutboxEntry,
  selectThreadDurableOutboxEntries,
} from "./durableOutboxPresentation";

const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");

function entry(state: DurableCommandOutboxEntry["state"]): DurableCommandOutboxEntry {
  return {
    plan: {
      schemaVersion: 1,
      environmentId,
      enqueuedAt: "2026-07-15T10:00:00.000Z",
      command: {
        type: "thread.message.queue",
        commandId: CommandId.make("command-1"),
        threadId,
        message: {
          messageId: MessageId.make("message-1"),
          role: "user",
          text: "Keep going",
          attachments: [],
        },
        titleSeed: "Keep going",
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-07-15T10:00:00.000Z",
      },
    },
    state,
  };
}

describe("durable outbox presentation", () => {
  it("offers edit and cancel only before delivery begins", () => {
    expect(presentDurableOutboxEntry(entry({ _tag: "Pending" }))).toMatchObject({
      canEdit: true,
      canCancel: true,
      canRetry: false,
      title: "Message saved on this device",
    });
    expect(
      presentDurableOutboxEntry(
        entry({
          _tag: "Delivering",
          attempt: 1,
          startedAt: "2026-07-15T10:00:01.000Z",
        }),
      ),
    ).toMatchObject({ canEdit: false, canCancel: false, canRetry: false });
  });

  it("makes a permanent rejection retryable only with a replacement identity", () => {
    expect(
      presentDurableOutboxEntry(
        entry({
          _tag: "Rejected",
          attempt: 2,
          failure: {
            classification: "permanent",
            message: "Thread was removed",
            failedAt: "2026-07-15T10:00:02.000Z",
          },
        }),
      ),
    ).toMatchObject({ canRetry: true, canDiscard: true, canEdit: false });
  });

  it("shows a visible automatic retry countdown", () => {
    expect(localRetryCountdownText(Date.parse("2026-07-15T10:00:05.100Z"), 0)).not.toBeNull();
    expect(localRetryCountdownText(5_100, 1_000)).toBe("Retrying in 5s");
  });

  it("selects only local intents for the active environment and thread", () => {
    const otherThread = {
      ...entry({ _tag: "Pending" }),
      plan: {
        ...entry({ _tag: "Pending" }).plan,
        command: {
          ...entry({ _tag: "Pending" }).plan.command,
          threadId: ThreadId.make("thread-2"),
        },
      },
    };
    expect(
      selectThreadDurableOutboxEntries(
        [entry({ _tag: "Pending" }), otherThread],
        environmentId,
        threadId,
      ),
    ).toHaveLength(1);
  });

  it("hands ownership to the remote queue after acknowledgement loss", () => {
    expect(
      selectThreadDurableOutboxEntries(
        [
          entry({
            _tag: "Retrying",
            attempt: 1,
            retryNotBefore: "2026-07-15T10:00:05.000Z",
            failure: {
              classification: "ambiguous",
              message: "Ack lost",
              failedAt: "2026-07-15T10:00:01.000Z",
            },
          }),
        ],
        environmentId,
        threadId,
        new Set(["message-1"]),
      ),
    ).toEqual([]);
  });
});
