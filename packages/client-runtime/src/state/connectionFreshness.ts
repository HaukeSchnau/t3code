import * as Option from "effect/Option";

import type {
  ConnectionAttemptError,
  ConnectionAttemptStage,
  SupervisorConnectionState,
} from "../connection/model.ts";
import type { EnvironmentShellState } from "./shell.ts";

export interface PresentedConnectionFailure {
  readonly reason: ConnectionAttemptError["reason"];
  readonly message: string;
  readonly traceId: string | null;
}

interface ConnectionProgressBase {
  readonly attempt: number;
  readonly generation: number;
}

export type EnvironmentConnectionProgress =
  | (ConnectionProgressBase & {
      readonly phase: "available";
      readonly stage: "idle";
      readonly attempt: 0;
      readonly failure: null;
    })
  | (ConnectionProgressBase & {
      readonly phase: "offline";
      readonly stage: "waiting-for-network";
      readonly failure: PresentedConnectionFailure | null;
    })
  | (ConnectionProgressBase & {
      readonly phase: "connecting" | "reconnecting";
      readonly stage: ConnectionAttemptStage;
      readonly failure: PresentedConnectionFailure | null;
    })
  | (ConnectionProgressBase & {
      readonly phase: "reconnecting";
      readonly stage: "waiting-to-retry";
      /** Supervisor-owned absolute epoch time. Observers must not schedule retries from it. */
      readonly retryAt: number;
      readonly failure: PresentedConnectionFailure;
    })
  | (ConnectionProgressBase & {
      readonly phase: "connected";
      readonly stage: "ready";
      readonly failure: null;
    })
  | (ConnectionProgressBase & {
      readonly phase: "error";
      readonly stage: "blocked";
      readonly failure: PresentedConnectionFailure;
    });

export interface SnapshotIdentity {
  /** Sequence embedded in this content snapshot; the private replay cursor may be newer. */
  readonly contentSequence: number;
  /** Server-authored content update time, not a client receipt time. */
  readonly updatedAt: string;
}

export type EnvironmentSnapshotFreshness =
  | {
      readonly status: "empty";
      readonly snapshot: null;
      readonly error: string | null;
    }
  | {
      readonly status: "cached";
      readonly snapshot: SnapshotIdentity;
      readonly error: string | null;
    }
  | {
      readonly status: "synchronizing";
      readonly snapshot: SnapshotIdentity | null;
      readonly error: null;
    }
  | {
      readonly status: "live";
      readonly snapshot: SnapshotIdentity;
      readonly error: null;
    };

export interface EnvironmentConnectionFreshnessProjection {
  readonly connection: EnvironmentConnectionProgress;
  readonly snapshot: EnvironmentSnapshotFreshness;
}

function invalidProjectionSource(detail: string): never {
  throw new Error(`Invalid connection freshness projection source: ${detail}`);
}

function presentFailure(error: ConnectionAttemptError): PresentedConnectionFailure {
  return {
    reason: error.reason,
    message: error.message,
    traceId: error.traceId ?? null,
  };
}

function optionalFailure(error: ConnectionAttemptError | null): PresentedConnectionFailure | null {
  return error === null ? null : presentFailure(error);
}

function requireFailure(
  state: SupervisorConnectionState,
  phase: "backoff" | "blocked",
): PresentedConnectionFailure {
  if (state.lastFailure === null) {
    return invalidProjectionSource(`${phase} connection has no failure`);
  }
  if (phase === "backoff" && state.lastFailure._tag !== "ConnectionTransientError") {
    return invalidProjectionSource("backoff connection carries a blocked failure");
  }
  if (phase === "blocked" && state.lastFailure._tag !== "ConnectionBlockedError") {
    return invalidProjectionSource("blocked connection carries a transient failure");
  }
  return presentFailure(state.lastFailure);
}

function requireDesiredState(state: SupervisorConnectionState): void {
  if (!state.desired) {
    invalidProjectionSource(`${state.phase} connection is not desired`);
  }
}

function requireAvailableNetwork(state: SupervisorConnectionState): void {
  if (state.network === "offline") {
    invalidProjectionSource(`${state.phase} connection claims an offline network`);
  }
}

function requirePositiveAttempt(state: SupervisorConnectionState): void {
  if (!Number.isInteger(state.attempt) || state.attempt <= 0) {
    invalidProjectionSource(`${state.phase} connection has a non-positive attempt`);
  }
}

export function projectEnvironmentConnectionProgress(
  state: SupervisorConnectionState,
): EnvironmentConnectionProgress {
  switch (state.phase) {
    case "available":
      if (
        state.desired ||
        state.attempt !== 0 ||
        state.stage !== null ||
        state.lastFailure !== null ||
        state.retryAt !== null
      ) {
        return invalidProjectionSource("available connection carries attempt state");
      }
      return {
        phase: "available",
        stage: "idle",
        attempt: 0,
        generation: state.generation,
        failure: null,
      };
    case "offline":
      if (
        !state.desired ||
        state.network !== "offline" ||
        !Number.isInteger(state.attempt) ||
        state.attempt < 0 ||
        state.stage !== null ||
        state.retryAt !== null
      ) {
        return invalidProjectionSource(
          "offline connection violates desired, network, attempt, stage, or retry invariants",
        );
      }
      return {
        phase: "offline",
        stage: "waiting-for-network",
        attempt: state.attempt,
        generation: state.generation,
        failure: optionalFailure(state.lastFailure),
      };
    case "connecting":
      requireDesiredState(state);
      requireAvailableNetwork(state);
      requirePositiveAttempt(state);
      if (state.stage === null || state.retryAt !== null) {
        return invalidProjectionSource(
          "connecting connection lacks a stage or carries a retry time",
        );
      }
      return {
        phase: state.attempt <= 1 && state.lastFailure === null ? "connecting" : "reconnecting",
        stage: state.stage,
        attempt: state.attempt,
        generation: state.generation,
        failure: optionalFailure(state.lastFailure),
      };
    case "backoff":
      requireDesiredState(state);
      requireAvailableNetwork(state);
      requirePositiveAttempt(state);
      if (state.stage !== null || state.retryAt === null) {
        return invalidProjectionSource("backoff connection lacks an exclusive retry time");
      }
      return {
        phase: "reconnecting",
        stage: "waiting-to-retry",
        attempt: state.attempt,
        generation: state.generation,
        retryAt: state.retryAt,
        failure: requireFailure(state, "backoff"),
      };
    case "connected":
      requireDesiredState(state);
      requireAvailableNetwork(state);
      requirePositiveAttempt(state);
      if (state.stage !== null || state.lastFailure !== null || state.retryAt !== null) {
        return invalidProjectionSource("connected connection carries pending attempt state");
      }
      return {
        phase: "connected",
        stage: "ready",
        attempt: state.attempt,
        generation: state.generation,
        failure: null,
      };
    case "blocked":
      requireDesiredState(state);
      requireAvailableNetwork(state);
      requirePositiveAttempt(state);
      if (state.stage !== null || state.retryAt !== null) {
        return invalidProjectionSource("blocked connection carries an active stage or retry time");
      }
      return {
        phase: "error",
        stage: "blocked",
        attempt: state.attempt,
        generation: state.generation,
        failure: requireFailure(state, "blocked"),
      };
  }
}

function snapshotIdentity(state: EnvironmentShellState): SnapshotIdentity | null {
  return Option.match(state.snapshot, {
    onNone: () => null,
    onSome: (snapshot) => ({
      contentSequence: snapshot.snapshotSequence,
      updatedAt: snapshot.updatedAt,
    }),
  });
}

export function projectEnvironmentSnapshotFreshness(
  state: EnvironmentShellState,
): EnvironmentSnapshotFreshness {
  const snapshot = snapshotIdentity(state);
  const error = Option.getOrNull(state.error);

  switch (state.status) {
    case "empty":
      if (snapshot !== null) {
        return invalidProjectionSource("empty shell carries a snapshot");
      }
      return { status: "empty", snapshot: null, error };
    case "cached":
      if (snapshot === null) {
        return invalidProjectionSource("cached shell has no snapshot");
      }
      return { status: "cached", snapshot, error };
    case "synchronizing":
      if (error !== null) {
        return invalidProjectionSource("synchronizing shell carries a stale error");
      }
      return { status: "synchronizing", snapshot, error: null };
    case "live":
      if (snapshot === null || error !== null) {
        return invalidProjectionSource("live shell lacks a snapshot or carries a stale error");
      }
      return { status: "live", snapshot, error: null };
  }
}

export function projectEnvironmentConnectionFreshness(
  state: SupervisorConnectionState,
  shell: EnvironmentShellState,
): EnvironmentConnectionFreshnessProjection {
  const connection = projectEnvironmentConnectionProgress(state);
  const snapshot = projectEnvironmentSnapshotFreshness(shell);

  // Supervisor and shell SubscriptionRefs update independently. Immediately
  // after a disconnect the shell may still say "live" for one observation.
  // Retain the content, but never claim live freshness without a ready transport.
  const reconciledSnapshot: EnvironmentSnapshotFreshness =
    connection.phase !== "connected" && snapshot.status === "live"
      ? { status: "cached", snapshot: snapshot.snapshot, error: null }
      : snapshot;

  return {
    connection,
    snapshot: reconciledSnapshot,
  };
}

/**
 * Calculates display-only retry timing from a caller's clock observation.
 * This function neither schedules nor requests a retry.
 */
export function retryRemainingMs(
  connection: EnvironmentConnectionProgress,
  nowMs: number,
): number | null {
  return connection.stage === "waiting-to-retry" ? Math.max(0, connection.retryAt - nowMs) : null;
}
