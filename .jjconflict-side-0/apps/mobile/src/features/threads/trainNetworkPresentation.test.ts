import { describe, expect, it } from "@effect/vitest";

import {
  presentLocalIntent,
  presentRemoteQueue,
  presentTrainConnectionStatus,
  TRAIN_NETWORK_SCREENSHOT_FIXTURES,
  trainStatusVisibilityDelayMs,
  TRAIN_STATUS_INITIAL_DELAY_MS,
  TRAIN_STATUS_RECOVERY_HOLD_MS,
} from "./trainNetworkPresentation";

const SNAPSHOT = { contentSequence: 7, updatedAt: "2026-07-15T10:00:00.000Z" };

describe("mobile train network presentation", () => {
  it("keeps locally durable intent distinct from the remote queue", () => {
    const pending = presentLocalIntent({ _tag: "Pending" });
    expect(pending.label).toBe("Saved on this device");
    expect(pending.detail).toContain("not in the remote queue");
    expect(pending).toMatchObject({ canEdit: true, canCancel: true, canDiscard: false });
    expect(presentRemoteQueue(2)).toBe("Remote queue · 2 messages waiting behind current work");
  });

  it("offers no mutation once delivery has started and discard only after rejection", () => {
    expect(
      presentLocalIntent({ _tag: "Delivering", attempt: 1, startedAt: "2026-07-15T10:00:00.000Z" }),
    ).toMatchObject({
      canEdit: false,
      canCancel: false,
      canDiscard: false,
    });
    expect(
      presentLocalIntent({
        _tag: "Retrying",
        attempt: 2,
        retryNotBefore: "2026-07-15T10:00:02.000Z",
        failure: {
          classification: "transient",
          message: "dropped",
          failedAt: "2026-07-15T10:00:00.000Z",
        },
      }),
    ).toMatchObject({ canEdit: false, canCancel: false, canDiscard: false });
    expect(
      presentLocalIntent({
        _tag: "Rejected",
        attempt: 1,
        failure: {
          classification: "permanent",
          message: "invalid",
          failedAt: "2026-07-15T10:00:00.000Z",
        },
      }),
    ).toMatchObject({ canEdit: false, canCancel: false, canDiscard: true });
  });

  it("reports cached content separately while offline", () => {
    const status = presentTrainConnectionStatus({
      projection: {
        connection: {
          phase: "offline",
          stage: "waiting-for-network",
          attempt: 2,
          generation: 1,
          failure: null,
        },
        snapshot: { status: "cached", snapshot: SNAPSHOT, error: null },
      },
      environmentLabel: "Workstation",
      nowMs: Date.parse("2026-07-15T10:00:00.000Z"),
      hasThreadContent: true,
    });
    expect(status?.label).toBe("Offline · showing saved conversation");
    expect(status?.accessibilityLabel).toContain("Messages saved on this device");
  });

  it("uses the supervisor retry deadline for an honest countdown", () => {
    const status = presentTrainConnectionStatus({
      projection: {
        connection: {
          phase: "reconnecting",
          stage: "waiting-to-retry",
          retryAt: Date.parse("2026-07-15T10:00:03.200Z"),
          attempt: 3,
          generation: 2,
          failure: { reason: "transport", message: "dropped", traceId: null },
        },
        snapshot: { status: "cached", snapshot: SNAPSHOT, error: null },
      },
      environmentLabel: "Workstation",
      nowMs: Date.parse("2026-07-15T10:00:00.000Z"),
      hasThreadContent: true,
    });
    expect(status?.label).toBe("Retrying in 4s · attempt 3 · showing saved conversation");
    expect(status?.accessibilityLabel).toBe(
      "Reconnecting to Workstation, attempt 3. Showing saved conversation while reconnecting.",
    );
  });

  it("calls the first fetch loading and keeps cached recovery quiet", () => {
    const connection = {
      phase: "connected" as const,
      stage: "ready" as const,
      attempt: 1,
      generation: 1,
      failure: null,
    };
    expect(
      presentTrainConnectionStatus({
        projection: {
          connection,
          snapshot: { status: "synchronizing", snapshot: null, error: null },
        },
        environmentLabel: null,
        nowMs: 0,
        hasThreadContent: false,
      })?.label,
    ).toBe("Loading conversation");
    expect(
      presentTrainConnectionStatus({
        projection: {
          connection,
          snapshot: { status: "synchronizing", snapshot: SNAPSHOT, error: null },
        },
        environmentLabel: null,
        nowMs: 0,
        hasThreadContent: true,
      }),
    ).toBeNull();
  });

  it("keeps a cached refresh failure visible", () => {
    const status = presentTrainConnectionStatus({
      projection: {
        connection: {
          phase: "connected",
          stage: "ready",
          attempt: 1,
          generation: 1,
          failure: null,
        },
        snapshot: {
          status: "cached",
          snapshot: SNAPSHOT,
          error: "Environment refresh failed",
        },
      },
      environmentLabel: null,
      nowMs: 0,
      hasThreadContent: true,
    });

    expect(status?.label).toBe("Update failed · showing saved conversation");
    expect(status?.accessibilityLabel).toContain("Environment refresh failed");
  });

  it("ships deterministic screenshot fixtures with local and remote queues separated", () => {
    expect(Object.keys(TRAIN_NETWORK_SCREENSHOT_FIXTURES)).toHaveLength(6);
    expect(
      TRAIN_NETWORK_SCREENSHOT_FIXTURES.cachedBackgroundReconciliation.connectionLabel,
    ).toBeNull();
    expect(TRAIN_NETWORK_SCREENSHOT_FIXTURES.remoteQueueDistinct.localIntent.label).toBe(
      "Saved on this device",
    );
    expect(TRAIN_NETWORK_SCREENSHOT_FIXTURES.remoteQueueDistinct.remoteQueueCount).toBe(2);
  });

  it("debounces transient startup and holds recovery without delaying offline feedback", () => {
    const reconnecting = {
      kind: "reconnecting" as const,
      label: "Reconnecting",
      accessibilityLabel: "Reconnecting.",
    };
    const offline = {
      kind: "unavailable" as const,
      label: "Offline",
      accessibilityLabel: "Offline.",
    };
    expect(trainStatusVisibilityDelayMs(null, reconnecting)).toBe(TRAIN_STATUS_INITIAL_DELAY_MS);
    expect(trainStatusVisibilityDelayMs(reconnecting, null)).toBe(TRAIN_STATUS_RECOVERY_HOLD_MS);
    expect(trainStatusVisibilityDelayMs(null, offline)).toBe(0);
  });
});
