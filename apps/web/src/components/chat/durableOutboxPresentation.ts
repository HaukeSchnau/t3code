import { canDiscardCommandOutboxEntry } from "@t3tools/client-runtime/state/command-outbox";

import type { DurableComposerEntry } from "../../durableCommandOutbox";

export interface DurableOutboxEntryView {
  readonly entry: DurableComposerEntry;
  readonly preview: string;
  readonly status: string;
  readonly rejected: boolean;
  /** Epoch milliseconds of the next automatic attempt, for a countdown. */
  readonly retryAt: number | null;
  /** Edit and discard take the message back; only safe while it cannot have arrived. */
  readonly canTakeBack: boolean;
  readonly retryLabel: "Retry" | "Retry now" | null;
}

function preview(entry: DurableComposerEntry): string {
  const firstLine = entry.command.text.trim().split("\n", 1)[0] ?? "";
  if (firstLine.length > 0) return firstLine;
  const count = entry.command.attachments.length;
  return count === 1 ? "1 attachment" : `${count} attachments`;
}

/** One row per waiting message of a thread, oldest first. */
export function presentDurableOutboxEntries(
  entries: ReadonlyArray<DurableComposerEntry>,
  connected: boolean,
): ReadonlyArray<DurableOutboxEntryView> {
  return entries.map((entry, index) => {
    const base = {
      entry,
      preview: preview(entry),
      rejected: false,
      retryAt: null,
      canTakeBack: canDiscardCommandOutboxEntry(entry),
      retryLabel: null,
    };
    const { state } = entry;
    switch (state._tag) {
      case "Pending":
        return {
          ...base,
          status:
            index > 0
              ? "Sends after the message above."
              : connected
                ? "Sending."
                : "Saved on this device. Sends when the connection is back.",
        };
      case "Delivering":
        return { ...base, status: "Sending." };
      case "Retrying":
        return {
          ...base,
          status:
            state.failure.classification === "ambiguous"
              ? "No reply from the environment yet. It is sent again with the same id, so it arrives once."
              : `Not sent yet: ${state.failure.message}`,
          retryAt: connected ? state.retryAt : null,
          retryLabel: connected ? "Retry now" : null,
        };
      case "Rejected":
        return {
          ...base,
          status: `Not delivered: ${state.failure.message}`,
          rejected: true,
          retryLabel: "Retry",
        };
    }
  });
}

export function retryCountdownText(retryAt: number | null, nowMs: number): string | null {
  if (retryAt === null) return null;
  const seconds = Math.ceil((retryAt - nowMs) / 1_000);
  return seconds > 0 ? `Retrying in ${seconds}s` : "Retrying";
}
