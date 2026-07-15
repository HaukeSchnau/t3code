import type { DurableCommandOutboxEntry } from "@t3tools/client-runtime/operations/command-outbox";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export interface DurableOutboxEntryView {
  readonly entry: DurableCommandOutboxEntry;
  readonly title: string;
  readonly detail: string;
  readonly canEdit: boolean;
  readonly canCancel: boolean;
  readonly canRetry: boolean;
  readonly canDiscard: boolean;
  readonly attempt: number | null;
  readonly retryAt: number | null;
}

export function selectThreadDurableOutboxEntries(
  entries: ReadonlyArray<DurableCommandOutboxEntry>,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ReadonlyArray<DurableCommandOutboxEntry> {
  return entries.filter(
    (entry) =>
      entry.plan.environmentId === environmentId && entry.plan.command.threadId === threadId,
  );
}

export function presentDurableOutboxEntry(
  entry: DurableCommandOutboxEntry,
): DurableOutboxEntryView {
  switch (entry.state._tag) {
    case "Pending":
      return {
        entry,
        title: "Message saved on this device",
        detail: "Will send automatically.",
        canEdit: true,
        canCancel: true,
        canRetry: false,
        canDiscard: false,
        attempt: null,
        retryAt: null,
      };
    case "Delivering":
      return {
        entry,
        title: "Sending saved message",
        detail: "Waiting for the remote environment to accept it.",
        canEdit: false,
        canCancel: false,
        canRetry: false,
        canDiscard: false,
        attempt: entry.state.attempt,
        retryAt: null,
      };
    case "Retrying":
      return {
        entry,
        title: "Message saved on this device",
        detail: "The last send failed. It will retry automatically.",
        canEdit: false,
        canCancel: false,
        canRetry: false,
        canDiscard: false,
        attempt: entry.state.attempt,
        retryAt: Date.parse(entry.state.retryNotBefore),
      };
    case "Rejected":
      return {
        entry,
        title: "Message rejected",
        detail: entry.state.failure.message,
        canEdit: false,
        canCancel: false,
        canRetry: true,
        canDiscard: true,
        attempt: entry.state.attempt,
        retryAt: null,
      };
  }
}

export function localRetryCountdownText(retryAt: number | null, nowMs: number): string | null {
  if (retryAt === null) return null;
  const seconds = Math.max(1, Math.ceil((retryAt - nowMs) / 1_000));
  return `Retrying in ${seconds}s`;
}
