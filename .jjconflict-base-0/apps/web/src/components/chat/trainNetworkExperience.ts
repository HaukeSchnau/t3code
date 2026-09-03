import {
  retryRemainingMs,
  type EnvironmentConnectionFreshnessProjection,
} from "@t3tools/client-runtime/state/connection-freshness";

export const NETWORK_DEGRADATION_HOLD_MS = 250;
export const NETWORK_RECOVERY_HOLD_MS = 500;

export interface TrainNetworkExperienceView {
  readonly kind: "degraded" | "recovered";
  readonly title: string;
  readonly detail: string;
  readonly attempt: number | null;
  readonly retryRemainingMs: number | null;
  readonly announcement: string;
}

function savedContentDetail(
  projection: EnvironmentConnectionFreshnessProjection,
  withoutContent: string,
): string {
  return projection.snapshot.snapshot === null ? withoutContent : "Showing saved content.";
}

export function deriveTrainNetworkExperience(
  projection: EnvironmentConnectionFreshnessProjection,
  nowMs: number,
): TrainNetworkExperienceView | null {
  const { connection, snapshot } = projection;

  if (connection.phase === "connected") {
    if (snapshot.error !== null) {
      const errorSentence = /[.!?]$/.test(snapshot.error) ? snapshot.error : `${snapshot.error}.`;
      const detail =
        snapshot.snapshot === null ? snapshot.error : `${errorSentence} Showing saved content.`;
      return {
        kind: "degraded",
        title: "Update failed",
        detail,
        attempt: connection.attempt,
        retryRemainingMs: null,
        announcement: `Update failed. ${detail}`,
      };
    }

    if (snapshot.snapshot !== null) {
      return null;
    }

    return {
      kind: "degraded",
      title: "Loading",
      detail: "Loading this conversation.",
      attempt: connection.attempt,
      retryRemainingMs: null,
      announcement: "Connected. Loading this conversation.",
    };
  }

  if (connection.phase === "available") {
    const detail = savedContentDetail(
      projection,
      "Connect this environment to load the conversation.",
    );
    return {
      kind: "degraded",
      title: "Not connected",
      detail,
      attempt: null,
      retryRemainingMs: null,
      announcement: `Not connected. ${detail}`,
    };
  }

  if (connection.phase === "offline") {
    const detail = savedContentDetail(
      projection,
      "Waiting for a connection before loading this conversation.",
    );
    return {
      kind: "degraded",
      title: "Offline",
      detail,
      attempt: connection.attempt > 0 ? connection.attempt : null,
      retryRemainingMs: null,
      announcement: `Offline. ${detail}`,
    };
  }

  if (connection.phase === "error") {
    const failure = connection.failure?.message ?? "Reconnect this environment to continue.";
    const failureSentence = /[.!?]$/.test(failure) ? failure : `${failure}.`;
    const detail =
      snapshot.snapshot === null ? failure : `${failureSentence} Showing saved content.`;
    return {
      kind: "degraded",
      title: "Connection failed",
      detail,
      attempt: connection.attempt,
      retryRemainingMs: null,
      announcement: `Connection failed. ${detail}`,
    };
  }

  const title = connection.phase === "connecting" ? "Connecting" : "Reconnecting";
  const detail = savedContentDetail(
    projection,
    connection.phase === "connecting"
      ? "Loading this conversation after connecting."
      : "Waiting to resume this conversation.",
  );
  return {
    kind: "degraded",
    title,
    detail,
    attempt: connection.attempt,
    retryRemainingMs: retryRemainingMs(connection, nowMs),
    announcement: `${title}. ${detail}`,
  };
}

export const RECOVERED_NETWORK_EXPERIENCE: TrainNetworkExperienceView = Object.freeze({
  kind: "recovered",
  title: "Connected",
  detail: "Conversation is up to date.",
  attempt: null,
  retryRemainingMs: null,
  announcement: "Connected. Conversation is up to date.",
});

export function retryCountdownText(remainingMs: number | null): string | null {
  if (remainingMs === null) return null;
  return `Retrying in ${Math.max(1, Math.ceil(remainingMs / 1_000))}s`;
}
