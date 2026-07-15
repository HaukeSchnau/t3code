import type { EnvironmentConnectionFreshnessProjection } from "@t3tools/client-runtime/state/connection-freshness";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveTrainNetworkExperience,
  NETWORK_DEGRADATION_HOLD_MS,
  NETWORK_RECOVERY_HOLD_MS,
  retryCountdownText,
} from "./trainNetworkExperience";

const snapshot = {
  status: "cached" as const,
  snapshot: { contentSequence: 8, updatedAt: "2026-07-15T10:00:00.000Z" },
  error: null,
};

function projection(
  connection: EnvironmentConnectionFreshnessProjection["connection"],
  nextSnapshot: EnvironmentConnectionFreshnessProjection["snapshot"] = snapshot,
): EnvironmentConnectionFreshnessProjection {
  return { connection, snapshot: nextSnapshot };
}

describe("train network experience presentation", () => {
  it("keeps transport and cached-content freshness as separate facts", () => {
    const view = deriveTrainNetworkExperience(
      projection({
        phase: "offline",
        stage: "waiting-for-network",
        attempt: 2,
        generation: 1,
        failure: null,
      }),
      0,
    );

    expect(view).toMatchObject({
      title: "Offline",
      detail: "Showing saved content.",
      announcement: "Offline. Showing saved content.",
    });
  });

  it("does not claim saved content when no cached snapshot exists", () => {
    const view = deriveTrainNetworkExperience(
      projection(
        {
          phase: "connecting",
          stage: "opening",
          attempt: 1,
          generation: 1,
          failure: null,
        },
        { status: "synchronizing", snapshot: null, error: null },
      ),
      0,
    );

    expect(view?.title).toBe("Connecting");
    expect(view?.detail).toBe("Loading this conversation after connecting.");
  });

  it("shows supervisor-owned attempt and retry countdown without inventing another retry", () => {
    const view = deriveTrainNetworkExperience(
      projection({
        phase: "reconnecting",
        stage: "waiting-to-retry",
        attempt: 3,
        generation: 2,
        retryAt: 14_100,
        failure: { reason: "network", message: "Link dropped", traceId: null },
      }),
      10_000,
    );

    expect(view).toMatchObject({ attempt: 3, retryRemainingMs: 4_100 });
    expect(retryCountdownText(view?.retryRemainingMs ?? null)).toBe("Retrying in 5s");
  });

  it("hides the surface only when transport and snapshot are both live", () => {
    const view = deriveTrainNetworkExperience(
      projection(
        {
          phase: "connected",
          stage: "ready",
          attempt: 2,
          generation: 2,
          failure: null,
        },
        { ...snapshot, status: "live" },
      ),
      0,
    );

    expect(view).toBeNull();
  });

  it("keeps the specified anti-flicker holds within the feedback budget", () => {
    expect(NETWORK_DEGRADATION_HOLD_MS).toBe(250);
    expect(NETWORK_DEGRADATION_HOLD_MS).toBeLessThan(300);
    expect(NETWORK_RECOVERY_HOLD_MS).toBe(500);
  });
});
