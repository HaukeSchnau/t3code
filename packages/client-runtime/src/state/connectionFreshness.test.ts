import type { OrchestrationShellSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import type { EnvironmentShellState } from "./shell.ts";
import {
  projectEnvironmentConnectionFreshness,
  projectEnvironmentConnectionProgress,
  projectEnvironmentSnapshotFreshness,
  retryRemainingMs,
} from "./connectionFreshness.ts";

const SNAPSHOT: OrchestrationShellSnapshot = {
  snapshotSequence: 42,
  projects: [],
  threads: [],
  usageLimits: [],
  updatedAt: "2026-07-15T12:00:00.000Z",
};

function connectionState(
  overrides: Partial<SupervisorConnectionState> = {},
): SupervisorConnectionState {
  return {
    desired: true,
    network: "online",
    phase: "connecting",
    stage: "preparing",
    attempt: 1,
    generation: 0,
    lastFailure: null,
    retryAt: null,
    ...overrides,
  };
}

function shellState(
  status: EnvironmentShellState["status"],
  snapshot: Option.Option<OrchestrationShellSnapshot>,
  error = Option.none<string>(),
): EnvironmentShellState {
  return { status, snapshot, error };
}

describe("connection freshness projection", () => {
  it("projects every connection phase without changing attempt ownership", () => {
    const transient = new ConnectionTransientError({
      reason: "transport",
      detail: "Socket closed.",
      traceId: "trace-retry",
    });
    const blocked = new ConnectionBlockedError({
      reason: "authentication",
      detail: "Sign in again.",
    });

    expect(
      projectEnvironmentConnectionProgress(
        connectionState({
          desired: false,
          phase: "available",
          stage: null,
          attempt: 0,
        }),
      ),
    ).toEqual({
      phase: "available",
      stage: "idle",
      attempt: 0,
      generation: 0,
      failure: null,
    });
    expect(
      projectEnvironmentConnectionProgress(
        connectionState({ network: "offline", phase: "offline", stage: null, attempt: 2 }),
      ),
    ).toMatchObject({
      phase: "offline",
      stage: "waiting-for-network",
      attempt: 2,
    });
    expect(
      projectEnvironmentConnectionProgress(
        connectionState({ stage: "opening", attempt: 2, lastFailure: transient }),
      ),
    ).toEqual({
      phase: "reconnecting",
      stage: "opening",
      attempt: 2,
      generation: 0,
      failure: {
        reason: "transport",
        message: "Socket closed.",
        traceId: "trace-retry",
      },
    });
    expect(
      projectEnvironmentConnectionProgress(
        connectionState({
          phase: "connected",
          stage: null,
          attempt: 2,
          generation: 2,
        }),
      ),
    ).toEqual({
      phase: "connected",
      stage: "ready",
      attempt: 2,
      generation: 2,
      failure: null,
    });
    expect(
      projectEnvironmentConnectionProgress(
        connectionState({ phase: "blocked", stage: null, lastFailure: blocked }),
      ),
    ).toMatchObject({
      phase: "error",
      stage: "blocked",
      failure: { reason: "authentication", message: "Sign in again.", traceId: null },
    });
  });

  it("exposes retryAt unchanged and derives only observation-time remaining duration", () => {
    const projected = projectEnvironmentConnectionProgress(
      connectionState({
        phase: "backoff",
        stage: null,
        attempt: 3,
        generation: 2,
        lastFailure: new ConnectionTransientError({
          reason: "timeout",
          detail: "Timed out.",
        }),
        retryAt: 10_000,
      }),
    );

    expect(projected).toMatchObject({
      phase: "reconnecting",
      stage: "waiting-to-retry",
      retryAt: 10_000,
    });
    expect(retryRemainingMs(projected, 7_500)).toBe(2_500);
    expect(retryRemainingMs(projected, 10_500)).toBe(0);
    expect(retryRemainingMs(projectEnvironmentConnectionProgress(connectionState()), 0)).toBeNull();
  });

  it("keeps snapshot sequence and update time coupled across freshness states", () => {
    const identity = {
      sequence: SNAPSHOT.snapshotSequence,
      updatedAt: SNAPSHOT.updatedAt,
    };

    expect(projectEnvironmentSnapshotFreshness(shellState("empty", Option.none()))).toEqual({
      status: "empty",
      snapshot: null,
      error: null,
    });
    expect(
      projectEnvironmentSnapshotFreshness(shellState("cached", Option.some(SNAPSHOT))),
    ).toEqual({ status: "cached", snapshot: identity, error: null });
    expect(
      projectEnvironmentSnapshotFreshness(shellState("synchronizing", Option.some(SNAPSHOT))),
    ).toEqual({ status: "synchronizing", snapshot: identity, error: null });
    expect(projectEnvironmentSnapshotFreshness(shellState("synchronizing", Option.none()))).toEqual(
      { status: "synchronizing", snapshot: null, error: null },
    );
    expect(projectEnvironmentSnapshotFreshness(shellState("live", Option.some(SNAPSHOT)))).toEqual({
      status: "live",
      snapshot: identity,
      error: null,
    });
  });

  it("keeps connection and snapshot freshness independent", () => {
    const projected = projectEnvironmentConnectionFreshness(
      connectionState({ phase: "connected", stage: null, generation: 1 }),
      shellState(
        "cached",
        Option.some(SNAPSHOT),
        Option.some("Could not synchronize environment data."),
      ),
    );

    expect(projected.connection.phase).toBe("connected");
    expect(projected.snapshot).toEqual({
      status: "cached",
      snapshot: { sequence: 42, updatedAt: "2026-07-15T12:00:00.000Z" },
      error: "Could not synchronize environment data.",
    });
  });

  it("rejects impossible nullable source combinations instead of publishing invalid unions", () => {
    expect(() =>
      projectEnvironmentConnectionProgress(
        connectionState({ phase: "backoff", stage: null, retryAt: null }),
      ),
    ).toThrow("backoff connection lacks an exclusive retry time");
    expect(() =>
      projectEnvironmentConnectionProgress(
        connectionState({ phase: "blocked", stage: null, lastFailure: null }),
      ),
    ).toThrow("blocked connection has no failure");
    expect(() => projectEnvironmentSnapshotFreshness(shellState("cached", Option.none()))).toThrow(
      "cached shell has no snapshot",
    );
    expect(() =>
      projectEnvironmentSnapshotFreshness(
        shellState("live", Option.some(SNAPSHOT), Option.some("stale error")),
      ),
    ).toThrow("live shell lacks a snapshot or carries a stale error");
  });
});
