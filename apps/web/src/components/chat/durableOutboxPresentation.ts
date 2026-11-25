import { canDiscardCommandOutboxEntry } from "@t3tools/client-runtime/state/command-outbox";
import { msg } from "gt-react";

import type { DurableComposerEntry } from "../../durableCommandOutbox";
import { m, type MessageResolver } from "../../i18n/messages";

export interface DurableOutboxEntryView {
  readonly entry: DurableComposerEntry;
  readonly preview: string;
  readonly status: string;
  readonly rejected: boolean;
  /** Epoch milliseconds of the next automatic attempt, for a countdown. */
  readonly retryAt: number | null;
  /** Edit and discard take the message back; only safe while it cannot have arrived. */
  readonly canTakeBack: boolean;
  readonly retryLabel: string | null;
}

function preview(entry: DurableComposerEntry, resolve: MessageResolver): string {
  const firstLine = entry.command.text.trim().split("\n", 1)[0] ?? "";
  if (firstLine.length > 0) return firstLine;
  return resolve(
    msg("{count, plural, one {{count} attachment} other {{count} attachments}}", {
      count: entry.command.attachments.length,
    }),
  );
}

/** One row per waiting message of a thread, oldest first. */
export function presentDurableOutboxEntries(
  entries: ReadonlyArray<DurableComposerEntry>,
  connected: boolean,
  resolve: MessageResolver = m,
): ReadonlyArray<DurableOutboxEntryView> {
  return entries.map((entry, index) => {
    const base = {
      entry,
      preview: preview(entry, resolve),
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
              ? resolve(msg("Sends after the message above."))
              : connected
                ? resolve(msg("Sending."))
                : resolve(msg("Saved on this device. Sends when the connection is back.")),
        };
      case "Delivering":
        return { ...base, status: resolve(msg("Sending.")) };
      case "Retrying":
        return {
          ...base,
          status:
            state.failure.classification === "ambiguous"
              ? resolve(
                  msg(
                    "No reply from the environment yet. It is sent again with the same id, so it arrives once.",
                  ),
                )
              : resolve(msg("Not sent yet: {reason}", { reason: state.failure.message })),
          retryAt: connected ? state.retryAt : null,
          retryLabel: connected ? resolve(msg("Retry now")) : null,
        };
      case "Rejected":
        return {
          ...base,
          status: resolve(msg("Not delivered: {reason}", { reason: state.failure.message })),
          rejected: true,
          retryLabel: resolve(msg("Retry", { $context: "verb" })),
        };
    }
  });
}

export function retryCountdownText(
  retryAt: number | null,
  nowMs: number,
  resolve: MessageResolver = m,
): string | null {
  if (retryAt === null) return null;
  const seconds = Math.ceil((retryAt - nowMs) / 1_000);
  return seconds > 0
    ? resolve(msg("Retrying in {seconds}s", { seconds }))
    : resolve(msg("Retrying"));
}
