import { describe, expect, it, vi } from "vitest";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import {
  deriveDisplayedUsageLimitsSnapshot,
  deriveLatestUsageLimitsSnapshot,
  deriveLatestUsageLimitsSnapshotForSources,
} from "./usageLimits";

function makeActivity(
  id: string,
  kind: string,
  payload: unknown,
  createdAt: string = "2026-03-23T00:00:00.000Z",
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt,
  };
}

function localIso(
  year: number,
  monthIndex: number,
  day: number,
  hour: number = 0,
  minute: number = 0,
): string {
  return new Date(year, monthIndex, day, hour, minute).toISOString();
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
    vi.setSystemTime(new Date(2026, 2, 23, 12, 30));

    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity("activity-1", "account.rate-limits.updated", {
        rateLimitReachedType: null,
        primary: {
          usedPercent: 60,
          resetsAt: localIso(2026, 2, 23, 15),
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

  it("keeps daytime 5h projections equivalent to wall-clock elapsed time", () => {
    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity("activity-1", "account.rate-limits.updated", {
        rateLimitReachedType: null,
        primary: {
          usedPercent: 60,
          resetsAt: localIso(2026, 2, 23, 15),
          windowDurationMins: 300,
        },
      }),
    ]);

    const displayed = deriveDisplayedUsageLimitsSnapshot(
      snapshot,
      new Date(2026, 2, 23, 12, 30).getTime(),
    );

    expect(displayed?.primary?.elapsedPercent).toBe(50);
    expect(displayed?.primary?.projectedPercentAtReset).toBe(120);
  });

  it("discounts sleep hours in 5h projections", () => {
    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity("activity-1", "account.rate-limits.updated", {
        rateLimitReachedType: null,
        primary: {
          usedPercent: 40,
          resetsAt: localIso(2026, 2, 23, 8),
          windowDurationMins: 300,
        },
      }),
    ]);

    const displayed = deriveDisplayedUsageLimitsSnapshot(
      snapshot,
      new Date(2026, 2, 23, 7, 30).getTime(),
    );

    expect(displayed?.primary?.elapsedPercent).toBe(50);
    expect(displayed?.primary?.projectedPercentAtReset).toBe(80);
  });

  it("returns unknown projection for 5h windows entirely inside sleep", () => {
    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity("activity-1", "account.rate-limits.updated", {
        rateLimitReachedType: null,
        primary: {
          usedPercent: 40,
          resetsAt: localIso(2026, 2, 23, 7),
          windowDurationMins: 300,
        },
      }),
    ]);

    const displayed = deriveDisplayedUsageLimitsSnapshot(
      snapshot,
      new Date(2026, 2, 23, 4).getTime(),
    );

    expect(displayed?.primary?.elapsedPercent).toBeNull();
    expect(displayed?.primary?.projectedPercentAtReset).toBeNull();
    expect(displayed?.primary?.status).toBe("unknown");
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

  it("discounts remaining weekend time in weekly projections", () => {
    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity("activity-1", "account.rate-limits.updated", {
        rateLimitReachedType: null,
        secondary: {
          usedPercent: 40,
          resetsAt: localIso(2026, 3, 27),
          windowDurationMins: 10080,
        },
      }),
    ]);

    const displayed = deriveDisplayedUsageLimitsSnapshot(snapshot, new Date(2026, 3, 24).getTime());

    expect(displayed?.secondary?.elapsedPercent).toBeCloseTo((4 / 5.5) * 100);
    expect(displayed?.secondary?.projectedPercentAtReset).toBeCloseTo(40 / (4 / 5.5));
    expect(displayed?.secondary?.projectedPercentAtReset).not.toBeCloseTo(70);
  });

  it("partially weights elapsed weekend segments in weekly projections", () => {
    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity("activity-1", "account.rate-limits.updated", {
        rateLimitReachedType: null,
        secondary: {
          usedPercent: 50,
          resetsAt: localIso(2026, 3, 27),
          windowDurationMins: 10080,
        },
      }),
    ]);

    const displayed = deriveDisplayedUsageLimitsSnapshot(
      snapshot,
      new Date(2026, 3, 25, 12).getTime(),
    );

    expect(displayed?.secondary?.elapsedPercent).toBeCloseTo((96.75 / 104.5) * 100);
    expect(displayed?.secondary?.projectedPercentAtReset).toBeCloseTo(50 / (96.75 / 104.5));
  });

  it("combines sleep and weekend weighting in weekly projections", () => {
    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity("activity-1", "account.rate-limits.updated", {
        rateLimitReachedType: null,
        secondary: {
          usedPercent: 50,
          resetsAt: localIso(2026, 3, 27),
          windowDurationMins: 10080,
        },
      }),
    ]);

    const displayed = deriveDisplayedUsageLimitsSnapshot(
      snapshot,
      new Date(2026, 3, 25, 8).getTime(),
    );

    expect(displayed?.secondary?.elapsedPercent).toBeCloseTo((95.75 / 104.5) * 100);
    expect(displayed?.secondary?.projectedPercentAtReset).toBeCloseTo(50 / (95.75 / 104.5));
  });

  it("prefers the newest valid snapshot across matching provider threads", () => {
    const snapshot = deriveLatestUsageLimitsSnapshotForSources(
      [
        {
          provider: "codex",
          activities: [
            makeActivity(
              "activity-1",
              "account.rate-limits.updated",
              {
                primary: {
                  usedPercent: 12,
                  resetsAt: "2026-03-23T05:00:00.000Z",
                  windowDurationMins: 300,
                },
              },
              "2026-03-23T01:00:00.000Z",
            ),
          ],
        },
        {
          provider: "claudeAgent",
          activities: [
            makeActivity(
              "activity-2",
              "account.rate-limits.updated",
              {
                primary: {
                  usedPercent: 99,
                  resetsAt: "2026-03-23T05:00:00.000Z",
                  windowDurationMins: 300,
                },
              },
              "2026-03-23T03:00:00.000Z",
            ),
          ],
        },
        {
          provider: "codex",
          activities: [
            makeActivity(
              "activity-3",
              "account.rate-limits.updated",
              {
                primary: {
                  usedPercent: 37,
                  resetsAt: "2026-03-23T05:00:00.000Z",
                  windowDurationMins: 300,
                },
              },
              "2026-03-23T02:00:00.000Z",
            ),
          ],
        },
      ],
      "codex",
    );

    expect(snapshot?.primary?.usedPercent).toBe(37);
    expect(snapshot?.updatedAt).toBe("2026-03-23T02:00:00.000Z");
  });

  it("does not let a newer stale snapshot lower usage within the same reset window", () => {
    const snapshot = deriveLatestUsageLimitsSnapshotForSources(
      [
        {
          provider: "codex",
          activities: [
            makeActivity(
              "activity-1",
              "account.rate-limits.updated",
              {
                secondary: {
                  usedPercent: 50,
                  resetsAt: "2026-03-30T00:00:00.000Z",
                  windowDurationMins: 10080,
                },
              },
              "2026-03-23T01:00:00.000Z",
            ),
          ],
        },
        {
          provider: "codex",
          activities: [
            makeActivity(
              "activity-2",
              "account.rate-limits.updated",
              {
                secondary: {
                  usedPercent: 20,
                  resetsAt: "2026-03-30T00:00:01.000Z",
                  windowDurationMins: 10080,
                },
              },
              "2026-03-23T01:00:01.000Z",
            ),
          ],
        },
      ],
      "codex",
    );

    expect(snapshot?.secondary?.usedPercent).toBe(50);
  });

  it("allows usage to drop when the reset window genuinely advances", () => {
    const snapshot = deriveLatestUsageLimitsSnapshotForSources(
      [
        {
          provider: "codex",
          activities: [
            makeActivity(
              "activity-1",
              "account.rate-limits.updated",
              {
                primary: {
                  usedPercent: 92,
                  resetsAt: "2026-03-23T05:00:00.000Z",
                  windowDurationMins: 300,
                },
              },
              "2026-03-23T04:55:00.000Z",
            ),
            makeActivity(
              "activity-2",
              "account.rate-limits.updated",
              {
                primary: {
                  usedPercent: 3,
                  resetsAt: "2026-03-23T10:00:00.000Z",
                  windowDurationMins: 300,
                },
              },
              "2026-03-23T05:01:00.000Z",
            ),
          ],
        },
      ],
      "codex",
    );

    expect(snapshot?.primary?.usedPercent).toBe(3);
  });

  it("selects primary and weekly windows independently across matching threads", () => {
    const snapshot = deriveLatestUsageLimitsSnapshotForSources(
      [
        {
          provider: "codex",
          activities: [
            makeActivity(
              "activity-1",
              "account.rate-limits.updated",
              {
                primary: {
                  usedPercent: 88,
                  resetsAt: "2026-03-23T05:00:00.000Z",
                  windowDurationMins: 300,
                },
                secondary: {
                  usedPercent: 27,
                  resetsAt: "2026-03-30T00:00:00.000Z",
                  windowDurationMins: 10080,
                },
              },
              "2026-03-23T04:55:00.000Z",
            ),
          ],
        },
        {
          provider: "codex",
          activities: [
            makeActivity(
              "activity-2",
              "account.rate-limits.updated",
              {
                primary: {
                  usedPercent: 6,
                  resetsAt: "2026-03-23T10:00:00.000Z",
                  windowDurationMins: 300,
                },
                secondary: {
                  usedPercent: 17,
                  resetsAt: "2026-03-30T00:00:01.000Z",
                  windowDurationMins: 10080,
                },
              },
              "2026-03-23T05:01:00.000Z",
            ),
          ],
        },
      ],
      "codex",
    );

    expect(snapshot?.primary?.usedPercent).toBe(6);
    expect(snapshot?.secondary?.usedPercent).toBe(27);
  });
});
