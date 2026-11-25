import {
  retryRemainingMs,
  type EnvironmentConnectionFreshnessProjection,
} from "@t3tools/client-runtime/state/connection-freshness";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

export const NETWORK_DEGRADATION_HOLD_MS = 250;
export const NETWORK_RECOVERY_HOLD_MS = 500;

export interface TrainNetworkExperienceView {
  readonly kind: "degraded" | "recovered";
  /** What the strip shows, independent of the language its title is in. */
  readonly state:
    | "update-failed"
    | "loading"
    | "not-connected"
    | "offline"
    | "connection-failed"
    | "connecting"
    | "reconnecting"
    | "connected";
  readonly title: string;
  readonly detail: string;
  readonly attempt: number | null;
  readonly retryRemainingMs: number | null;
  readonly announcement: string;
}

function savedContentDetail(
  projection: EnvironmentConnectionFreshnessProjection,
  withoutContent: string,
  resolve: MessageResolver,
): string {
  return projection.snapshot.snapshot === null
    ? withoutContent
    : resolve(msg("Showing saved content."));
}

export function deriveTrainNetworkExperience(
  projection: EnvironmentConnectionFreshnessProjection,
  nowMs: number,
  resolve: MessageResolver = m,
): TrainNetworkExperienceView | null {
  const { connection, snapshot } = projection;

  if (connection.phase === "connected") {
    if (snapshot.error !== null) {
      const errorSentence = /[.!?]$/.test(snapshot.error) ? snapshot.error : `${snapshot.error}.`;
      const detail =
        snapshot.snapshot === null
          ? snapshot.error
          : resolve(msg("{error} Showing saved content.", { error: errorSentence }));
      return {
        kind: "degraded",
        state: "update-failed",
        title: resolve(msg("Update failed")),
        detail,
        attempt: connection.attempt,
        retryRemainingMs: null,
        announcement: resolve(msg("Update failed. {detail}", { detail })),
      };
    }

    if (snapshot.snapshot !== null) {
      return null;
    }

    return {
      kind: "degraded",
      state: "loading",
      title: resolve(msg("Loading", { $context: "connection status" })),
      detail: resolve(msg("Loading this conversation.")),
      attempt: connection.attempt,
      retryRemainingMs: null,
      announcement: resolve(msg("Connected. Loading this conversation.")),
    };
  }

  if (connection.phase === "available") {
    const detail = savedContentDetail(
      projection,
      resolve(msg("Connect this environment to load the conversation.")),
      resolve,
    );
    return {
      kind: "degraded",
      state: "not-connected",
      title: resolve(msg("Not connected")),
      detail,
      attempt: null,
      retryRemainingMs: null,
      announcement: resolve(msg("Not connected. {detail}", { detail })),
    };
  }

  if (connection.phase === "offline") {
    const detail = savedContentDetail(
      projection,
      resolve(msg("Waiting for a connection before loading this conversation.")),
      resolve,
    );
    return {
      kind: "degraded",
      state: "offline",
      title: resolve(msg("Offline")),
      detail,
      attempt: connection.attempt > 0 ? connection.attempt : null,
      retryRemainingMs: null,
      announcement: resolve(msg("Offline. {detail}", { detail })),
    };
  }

  if (connection.phase === "error") {
    const failure =
      connection.failure?.message ?? resolve(msg("Reconnect this environment to continue."));
    const failureSentence = /[.!?]$/.test(failure) ? failure : `${failure}.`;
    const detail =
      snapshot.snapshot === null
        ? failure
        : resolve(msg("{error} Showing saved content.", { error: failureSentence }));
    return {
      kind: "degraded",
      state: "connection-failed",
      title: resolve(msg("Connection failed")),
      detail,
      attempt: connection.attempt,
      retryRemainingMs: null,
      announcement: resolve(msg("Connection failed. {detail}", { detail })),
    };
  }

  const connecting = connection.phase === "connecting";
  const detail = savedContentDetail(
    projection,
    connecting
      ? resolve(msg("Loading this conversation after connecting."))
      : resolve(msg("Waiting to resume this conversation.")),
    resolve,
  );
  return {
    kind: "degraded",
    state: connecting ? "connecting" : "reconnecting",
    title: connecting ? resolve(msg("Connecting")) : resolve(msg("Reconnecting")),
    detail,
    attempt: connection.attempt,
    retryRemainingMs: retryRemainingMs(connection, nowMs),
    announcement: connecting
      ? resolve(msg("Connecting. {detail}", { detail }))
      : resolve(msg("Reconnecting. {detail}", { detail })),
  };
}

export function recoveredNetworkExperience(
  resolve: MessageResolver = m,
): TrainNetworkExperienceView {
  return {
    kind: "recovered",
    state: "connected",
    title: resolve(msg("Connected")),
    detail: resolve(msg("Conversation is up to date.")),
    attempt: null,
    retryRemainingMs: null,
    announcement: resolve(msg("Connected. Conversation is up to date.")),
  };
}

export function retryCountdownText(
  remainingMs: number | null,
  resolve: MessageResolver = m,
): string | null {
  if (remainingMs === null) return null;
  return resolve(
    msg("Retrying in {seconds}s", { seconds: Math.max(1, Math.ceil(remainingMs / 1_000)) }),
  );
}
