import { describe, expect, it, vi } from "vitest";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import { deriveDisplayedUsageLimitsSnapshot, deriveLatestUsageLimitsSnapshot } from "./usageLimits";

function makeActivity(id: string, kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
}

describe("usageLimits", () => {
  it("derives the latest valid usage limits snapshot", () => {
    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity("activity-1", "account.rate-limits.updated", {
        primary: {
          usedPercent: 12,
          resetsAt: "2026-03-23T05:00:00.000Z",
          windowDurationMins: 300,
        },
      }),
      makeActivity("activity-2", "tool.completed", {}),
      makeActivity("activity-3", "account.rate-limits.updated", {
        limitId: "codex",
        limitName: "Codex",
        primary: {
          usedPercent: 48,
          resetsAt: "2026-03-23T05:00:00.000Z",
          windowDurationMins: 300,
        },
        secondary: {
          usedPercent: 15,
          resetsAt: "2026-03-30T00:00:00.000Z",
          windowDurationMins: 10080,
        },
      }),
    ]);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.limitId).toBe("codex");
    expect(snapshot?.primary?.usedPercent).toBe(48);
    expect(snapshot?.secondary?.windowDurationMins).toBe(10080);
  });

  it("ignores malformed payloads without usable windows", () => {
    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity("activity-1", "account.rate-limits.updated", {
        limitId: "codex",
      }),
    ]);

    expect(snapshot).toBeNull();
  });

  it("normalizes numeric reset timestamps in activity payloads", () => {
    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity("activity-1", "account.rate-limits.updated", {
        primary: {
          usedPercent: 72,
          resetsAt: 1_746_052_800,
          windowDurationMins: 300,
        },
      }),
    ]);

    expect(snapshot?.primary?.resetsAt).toBe("2025-04-30T22:40:00.000Z");
  });

  it("derives duration labels and pace status", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T02:30:00.000Z"));

    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity("activity-1", "account.rate-limits.updated", {
        rateLimitReachedType: null,
        primary: {
          usedPercent: 60,
          resetsAt: "2026-03-23T05:00:00.000Z",
          windowDurationMins: 300,
        },
        secondary: {
          usedPercent: 10,
          resetsAt: "2026-03-30T00:00:00.000Z",
          windowDurationMins: 10080,
        },
      }),
    ]);

    const displayed = deriveDisplayedUsageLimitsSnapshot(snapshot, Date.now());

    expect(displayed?.primary?.durationLabel).toBe("5h");
    expect(displayed?.primary?.elapsedPercent).toBe(50);
    expect(displayed?.primary?.projectedPercentAtReset).toBe(120);
    expect(displayed?.primary?.status).toBe("atRisk");
    expect(displayed?.secondary?.durationLabel).toBe("1w");

    vi.useRealTimers();
  });

  it("marks reached limits when the provider reports a reached type", () => {
    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity("activity-1", "account.rate-limits.updated", {
        rateLimitReachedType: "rate_limit_reached",
        primary: {
          usedPercent: 82,
          resetsAt: "2026-03-23T05:00:00.000Z",
          windowDurationMins: 300,
        },
      }),
    ]);

    const displayed = deriveDisplayedUsageLimitsSnapshot(
      snapshot,
      new Date("2026-03-23T02:30:00.000Z").getTime(),
    );

    expect(displayed?.primary?.status).toBe("reached");
    expect(displayed?.compactWindow).toBe("primary");
  });
});
