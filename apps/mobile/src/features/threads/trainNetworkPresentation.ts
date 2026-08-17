import type {
  EnvironmentConnectionFreshnessProjection,
  EnvironmentConnectionProgress,
} from "@t3tools/client-runtime/state/connection-freshness";
import type { DurableCommandState } from "@t3tools/client-runtime/operations/command-outbox";

export const TRAIN_STATUS_INITIAL_DELAY_MS = 250;
export const TRAIN_STATUS_RECOVERY_HOLD_MS = 500;

export type LocalIntentPresentation = {
  readonly label: string;
  readonly detail: string;
  readonly tone: "neutral" | "progress" | "danger";
  readonly canEdit: boolean;
  readonly canCancel: boolean;
  readonly canDiscard: boolean;
};

export function presentLocalIntent(
  state: DurableCommandState | undefined,
): LocalIntentPresentation {
  switch (state?._tag) {
    case "Delivering":
      return {
        label: "Sending from this device",
        detail: "Saved locally. Waiting for the remote environment to confirm receipt.",
        tone: "progress",
        canEdit: false,
        canCancel: false,
        canDiscard: false,
      };
    case "Retrying":
      return {
        label: "Saved on this device · retrying",
        detail: "T3 Code will try again automatically. The message is not in the remote queue yet.",
        tone: "progress",
        canEdit: false,
        canCancel: false,
        canDiscard: false,
      };
    case "Rejected":
      return {
        label: "Could not send",
        detail: "Saved on this device, but automatic retries stopped.",
        tone: "danger",
        canEdit: false,
        canCancel: false,
        canDiscard: true,
      };
    case "Pending":
    default:
      return {
        label: "Saved on this device",
        detail: "Waiting to send. This is not in the remote queue yet.",
        tone: "neutral",
        canEdit: true,
        canCancel: true,
        canDiscard: false,
      };
  }
}

export type TrainConnectionStatus = {
  readonly kind: "loading" | "unavailable" | "reconnecting";
  readonly label: string;
  readonly accessibilityLabel: string;
};

export function trainStatusVisibilityDelayMs(
  current: TrainConnectionStatus | null,
  next: TrainConnectionStatus | null,
): number {
  if (next === null) return current === null ? 0 : TRAIN_STATUS_RECOVERY_HOLD_MS;
  if (current === null && next.kind !== "unavailable") return TRAIN_STATUS_INITIAL_DELAY_MS;
  return 0;
}

function retrySeconds(connection: EnvironmentConnectionProgress, nowMs: number): number | null {
  if (connection.stage !== "waiting-to-retry") return null;
  return Math.max(0, Math.ceil((connection.retryAt - nowMs) / 1_000));
}

export function presentTrainConnectionStatus(input: {
  readonly projection: EnvironmentConnectionFreshnessProjection;
  readonly environmentLabel: string | null;
  readonly nowMs: number;
  readonly hasThreadContent: boolean;
}): TrainConnectionStatus | null {
  const { connection, snapshot } = input.projection;
  const environment = input.environmentLabel ?? "Remote environment";
  switch (connection.phase) {
    case "offline":
      return {
        kind: "unavailable",
        label: input.hasThreadContent ? "Offline · showing saved conversation" : "Offline",
        accessibilityLabel: `Offline. ${input.hasThreadContent ? "Showing saved conversation. " : ""}Messages saved on this device will send when connected.`,
      };
    case "connecting":
    case "reconnecting": {
      const seconds = retrySeconds(connection, input.nowMs);
      const retry = seconds === null ? "Reconnecting" : `Retrying in ${seconds}s`;
      const attempt = `attempt ${connection.attempt}`;
      return {
        kind: "reconnecting",
        label: input.hasThreadContent
          ? `${retry} · ${attempt} · showing saved conversation`
          : `${retry} · ${attempt}`,
        // Deliberately excludes the per-second countdown. The live region
        // changes only when phase or supervisor-owned attempt changes.
        accessibilityLabel: `Reconnecting to ${environment}, ${attempt}. ${input.hasThreadContent ? "Showing saved conversation while reconnecting." : ""}`,
      };
    }
    case "error":
      return {
        kind: "unavailable",
        label: input.hasThreadContent
          ? "Connection needs attention · showing saved conversation"
          : "Connection needs attention",
        accessibilityLabel: `Could not connect to ${environment}. ${input.hasThreadContent ? "Showing saved conversation." : ""}`,
      };
    case "available":
      return {
        kind: "unavailable",
        label: input.hasThreadContent
          ? "Not connected · showing saved conversation"
          : "Not connected",
        accessibilityLabel: `${environment} is not connected. ${input.hasThreadContent ? "Showing saved conversation." : ""}`,
      };
    case "connected":
      if (snapshot.error !== null) {
        const errorSentence = /[.!?]$/.test(snapshot.error) ? snapshot.error : `${snapshot.error}.`;
        return {
          kind: "unavailable",
          label: input.hasThreadContent
            ? "Update failed · showing saved conversation"
            : "Update failed",
          accessibilityLabel: `Could not update this conversation. ${errorSentence} ${input.hasThreadContent ? "Showing saved conversation." : ""}`,
        };
      }
      if (snapshot.status === "synchronizing" || snapshot.status === "cached") {
        if (input.hasThreadContent) return null;
        return {
          kind: "loading",
          label: "Loading conversation",
          accessibilityLabel: "Connected. Loading conversation.",
        };
      }
      return null;
  }
}

export function presentRemoteQueue(count: number): string | null {
  if (count <= 0) return null;
  return `Remote queue · ${count} message${count === 1 ? "" : "s"} waiting behind current work`;
}

const FIXTURE_FAILURE = {
  classification: "transient",
  message: "connection dropped",
  failedAt: "2026-07-15T10:00:00.000Z",
} as const;

/** Stable, clock-free inputs for the iOS/Android screenshot matrix. */
export const TRAIN_NETWORK_SCREENSHOT_FIXTURES = {
  offlineCachedPending: {
    connectionLabel: "Offline · showing saved conversation",
    freshness: "cached",
    localIntent: presentLocalIntent({ _tag: "Pending" }),
    remoteQueueCount: 0,
  },
  retryCountdownCached: {
    connectionLabel: "Retrying in 4s · attempt 2 · showing saved conversation",
    freshness: "cached",
    localIntent: presentLocalIntent({
      _tag: "Retrying",
      attempt: 2,
      retryNotBefore: "2026-07-15T10:00:04.000Z",
      failure: FIXTURE_FAILURE,
    }),
    remoteQueueCount: 0,
  },
  cachedBackgroundReconciliation: {
    connectionLabel: null,
    freshness: "synchronizing",
    localIntent: null,
    remoteQueueCount: 0,
  },
  deliveringLocalIntent: {
    connectionLabel: null,
    freshness: "live",
    localIntent: presentLocalIntent({
      _tag: "Delivering",
      attempt: 1,
      startedAt: "2026-07-15T10:00:00.000Z",
    }),
    remoteQueueCount: 0,
  },
  rejectedLocalIntent: {
    connectionLabel: "Connection needs attention · showing saved conversation",
    freshness: "cached",
    localIntent: presentLocalIntent({
      _tag: "Rejected",
      attempt: 1,
      failure: {
        classification: "permanent",
        message: "command rejected",
        failedAt: "2026-07-15T10:00:00.000Z",
      },
    }),
    remoteQueueCount: 0,
  },
  remoteQueueDistinct: {
    connectionLabel: null,
    freshness: "live",
    localIntent: presentLocalIntent({ _tag: "Pending" }),
    remoteQueueCount: 2,
  },
} as const;
