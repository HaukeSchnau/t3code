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

  it("keeps Claude scoped limits alongside its session and weekly windows", () => {
    const snapshot = deriveLatestUsageLimitsSnapshotForSources(
      [
        {
          provider: "claudeAgent",
          usageLimits: [
            {
              limitId: "claude",
              limitName: "Claude usage",
              planType: null,
              rateLimitReachedType: null,
              credits: null,
              primary: {
                key: "session",
                label: "Current session",
                usedPercent: 96,
                resetsAt: "2026-08-21T17:00:00.000Z",
                windowDurationMins: 300,
              },
              secondary: {
                key: "weekly-all",
                label: "All models",
                usedPercent: 13,
                resetsAt: "2026-08-28T05:00:00.000Z",
                windowDurationMins: 10080,
              },
              windows: [
                {
                  key: "session",
                  label: "Current session",
                  usedPercent: 96,
                  resetsAt: "2026-08-21T17:00:00.000Z",
                  windowDurationMins: 300,
                },
                {
                  key: "weekly-all",
                  label: "All models",
                  usedPercent: 13,
                  resetsAt: "2026-08-28T05:00:00.000Z",
                  windowDurationMins: 10080,
                },
                {
                  key: "weekly-scoped:fable",
                  label: "Fable",
                  usedPercent: 0,
                  resetsAt: null,
                  windowDurationMins: 10080,
                },
              ],
              updatedAt: "2026-08-21T12:00:00.000Z",
            },
          ],
        },
      ],
      "claudeAgent",
    );

    expect(
      snapshot?.windows?.map((window) => [window.key, window.label, window.usedPercent]),
    ).toEqual([
      ["session", "Current session", 96],
      ["weekly-all", "All models", 13],
      ["weekly-scoped:fable", "Fable", 0],
    ]);
  });

  it("uses limits from the selected provider instance", () => {
    const makeSnapshot = (usedPercent: number) => ({
      limitId: "claude",
      limitName: "Claude usage",
      planType: null,
      rateLimitReachedType: null,
      credits: null,
      primary: {
        usedPercent,
        resetsAt: "2026-08-21T17:00:00.000Z",
        windowDurationMins: 300,
      },
      secondary: null,
      updatedAt: "2026-08-21T12:00:00.000Z",
    });
    const snapshot = deriveLatestUsageLimitsSnapshotForSources(
      [
        {
          provider: "claudeAgent",
          providerInstanceId: "claude-personal",
          usageLimits: [makeSnapshot(96)],
        },
        {
          provider: "claudeAgent",
          providerInstanceId: "claude-work",
          usageLimits: [makeSnapshot(12)],
        },
      ],
      "claudeAgent",
      "claude-work",
    );

    expect(snapshot?.primary?.usedPercent).toBe(12);
  });

  it("unwraps nested Codex rate limit payload envelopes", () => {
    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity("activity-1", "account.rate-limits.updated", {
        rateLimits: {
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            primary: {
              usedPercent: 31,
              resetsAt: "2026-03-23T05:00:00.000Z",
              windowDurationMins: 300,
            },
          },
        },
      }),
    ]);

    expect(snapshot?.limitId).toBe("codex");
    expect(snapshot?.limitName).toBe("Codex");
    expect(snapshot?.primary?.usedPercent).toBe(31);
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

  it("uses individual limit remaining percentage for the weekly window", () => {
    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity("activity-1", "account.rate-limits.updated", {
        limitId: "codex",
        limitName: "Codex",
        primary: {
          usedPercent: 24,
          resetsAt: "2026-03-23T05:00:00.000Z",
          windowDurationMins: 300,
        },
        individualLimit: {
          remainingPercent: 63,
          resetsAt: 1_774_224_000,
          limit: "100",
          used: "37",
        },
      }),
    ]);

    expect(snapshot?.secondary?.usedPercent).toBe(37);
    expect(snapshot?.secondary?.resetsAt).toBe("2026-03-23T00:00:00.000Z");
    expect(snapshot?.secondary?.windowDurationMins).toBeNull();
  });

  it("repairs a stale zero weekly window from individual limit usage", () => {
    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity("activity-1", "account.rate-limits.updated", {
        secondary: {
          usedPercent: 0,
          resetsAt: "2026-03-30T00:00:00.000Z",
          windowDurationMins: 10080,
        },
        individualLimit: {
          remainingPercent: 82,
          resetsAt: "2026-03-30T00:00:00.000Z",
          limit: "100",
          used: "18",
        },
      }),
    ]);

    expect(snapshot?.secondary?.usedPercent).toBe(18);
  });

  it("derives duration labels and pace status", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 23, 12, 30));

    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity(
        "activity-1",
        "account.rate-limits.updated",
        {
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
        },
        localIso(2026, 2, 23, 12, 30),
      ),
    ]);

    const displayed = deriveDisplayedUsageLimitsSnapshot(snapshot, Date.now());

    expect(displayed?.primary?.durationLabel).toBe("5h");
    expect(displayed?.primary?.elapsedPercent).toBe(50);
    expect(displayed?.primary?.projectedPercentAtReset).toBe(120);
    expect(displayed?.primary?.status).toBe("atRisk");
    expect(displayed?.secondary?.durationLabel).toBe("1w");

    vi.useRealTimers();
  });

  it("derives reset labels from the supplied snapshot clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T12:00:00.000Z"));

    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity("activity-1", "account.rate-limits.updated", {
        rateLimitReachedType: null,
        primary: {
          usedPercent: 10,
          resetsAt: "2026-03-23T13:00:00.000Z",
          windowDurationMins: 300,
        },
      }),
    ]);

    const displayed = deriveDisplayedUsageLimitsSnapshot(
      snapshot,
      new Date("2026-03-23T12:30:00.000Z").getTime(),
    );

    expect(displayed?.primary?.resetRelativeLabel).toBe("30m left");

    vi.useRealTimers();
  });

  it("keeps forecasts anchored to the observation while countdowns advance", () => {
    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity(
        "activity-anchored",
        "account.rate-limits.updated",
        {
          primary: {
            usedPercent: 45,
            resetsAt: "2026-03-23T15:00:00.000Z",
            windowDurationMins: 300,
          },
        },
        "2026-03-23T11:55:00.000Z",
      ),
    ]);

    const first = deriveDisplayedUsageLimitsSnapshot(
      snapshot,
      Date.parse("2026-03-23T12:00:00.000Z"),
    );
    const later = deriveDisplayedUsageLimitsSnapshot(
      snapshot,
      Date.parse("2026-03-23T12:04:00.000Z"),
    );

    expect(later?.primary?.elapsedPercent).toBe(first?.primary?.elapsedPercent);
    expect(later?.primary?.projectedPercentAtReset).toBe(first?.primary?.projectedPercentAtReset);
    expect(first?.primary?.resetRelativeLabel).toBe("3h left");
    expect(later?.primary?.resetRelativeLabel).toBe("2h left");
  });

  it("marks ten-minute-old observations stale and pauses their forecast", () => {
    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity(
        "activity-stale",
        "account.rate-limits.updated",
        {
          primary: {
            usedPercent: 45,
            resetsAt: "2026-03-23T15:00:00.000Z",
            windowDurationMins: 300,
          },
        },
        "2026-03-23T11:55:00.000Z",
      ),
    ]);

    const displayed = deriveDisplayedUsageLimitsSnapshot(
      snapshot,
      Date.parse("2026-03-23T12:06:00.000Z"),
    );

    expect(displayed?.isStale).toBe(true);
    expect(displayed?.updatedRelativeLabel).toBe("Updated 11m ago");
    expect(displayed?.primary?.isStale).toBe(true);
    expect(displayed?.primary?.status).toBe("unknown");
    expect(displayed?.primary?.depletionForecast).toEqual({ kind: "unknown" });
  });

  it("treats an expired observed window as awaiting refresh", () => {
    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity(
        "activity-expired",
        "account.rate-limits.updated",
        {
          primary: {
            usedPercent: 45,
            resetsAt: "2026-03-23T12:03:00.000Z",
            windowDurationMins: 300,
          },
        },
        "2026-03-23T11:55:00.000Z",
      ),
    ]);

    const displayed = deriveDisplayedUsageLimitsSnapshot(
      snapshot,
      Date.parse("2026-03-23T12:06:00.000Z"),
    );

    expect(displayed?.primary?.resetExpired).toBe(true);
    expect(displayed?.primary?.status).toBe("unknown");
  });

  it("keeps daytime 5h projections equivalent to wall-clock elapsed time", () => {
    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity(
        "activity-1",
        "account.rate-limits.updated",
        {
          rateLimitReachedType: null,
          primary: {
            usedPercent: 60,
            resetsAt: localIso(2026, 2, 23, 15),
            windowDurationMins: 300,
          },
        },
        localIso(2026, 2, 23, 12, 30),
      ),
    ]);

    const displayed = deriveDisplayedUsageLimitsSnapshot(
      snapshot,
      new Date(2026, 2, 23, 12, 30).getTime(),
    );

    expect(displayed?.primary?.elapsedPercent).toBe(50);
    expect(displayed?.primary?.projectedPercentAtReset).toBe(120);
    expect(displayed?.primary?.depletionForecast).toEqual({
      kind: "beforeReset",
      estimatedAtMs: new Date(2026, 2, 23, 14, 10).getTime(),
      range: null,
    });
  });

  it("carries depletion estimates across discounted sleep hours", () => {
    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity("activity-1", "account.rate-limits.updated", {
        rateLimitReachedType: null,
        primary: {
          usedPercent: 40,
          resetsAt: localIso(2026, 2, 23, 8),
          windowDurationMins: 480,
        },
      }),
    ]);

    const displayed = deriveDisplayedUsageLimitsSnapshot(
      snapshot,
      new Date(2026, 2, 23, 1).getTime(),
    )?.primary;

    expect(displayed?.depletionForecast.kind).toBe("beforeReset");
    if (displayed?.depletionForecast.kind === "beforeReset") {
      const estimatedAt = new Date(displayed.depletionForecast.estimatedAtMs);
      expect(estimatedAt.getHours()).toBe(7);
      expect(estimatedAt.getMinutes()).toBe(38);
    }
  });

  it("discounts sleep hours in 5h projections", () => {
    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity(
        "activity-1",
        "account.rate-limits.updated",
        {
          rateLimitReachedType: null,
          primary: {
            usedPercent: 40,
            resetsAt: localIso(2026, 2, 23, 8),
            windowDurationMins: 300,
          },
        },
        localIso(2026, 2, 23, 7, 30),
      ),
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
      makeActivity(
        "activity-1",
        "account.rate-limits.updated",
        {
          rateLimitReachedType: "rate_limit_reached",
          primary: {
            usedPercent: 82,
            resetsAt: "2026-03-23T05:00:00.000Z",
            windowDurationMins: 300,
          },
        },
        "2026-03-23T02:30:00.000Z",
      ),
    ]);

    const displayed = deriveDisplayedUsageLimitsSnapshot(
      snapshot,
      new Date("2026-03-23T02:30:00.000Z").getTime(),
    );

    expect(displayed?.primary?.status).toBe("reached");
    expect(displayed?.primary?.depletionForecast).toEqual({ kind: "reached" });
    expect(displayed?.compactWindow).toBe("primary");
  });

  it("discounts remaining weekend time in weekly projections", () => {
    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity(
        "activity-1",
        "account.rate-limits.updated",
        {
          rateLimitReachedType: null,
          secondary: {
            usedPercent: 40,
            resetsAt: localIso(2026, 3, 27),
            windowDurationMins: 10080,
          },
        },
        localIso(2026, 3, 24),
      ),
    ]);

    const displayed = deriveDisplayedUsageLimitsSnapshot(snapshot, new Date(2026, 3, 24).getTime());

    expect(displayed?.secondary?.elapsedPercent).toBeCloseTo((4 / 5.5) * 100);
    expect(displayed?.secondary?.projectedPercentAtReset).toBeCloseTo(40 / (4 / 5.5));
    expect(displayed?.secondary?.projectedPercentAtReset).not.toBeCloseTo(70);
  });

  it("partially weights elapsed weekend segments in weekly projections", () => {
    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity(
        "activity-1",
        "account.rate-limits.updated",
        {
          rateLimitReachedType: null,
          secondary: {
            usedPercent: 50,
            resetsAt: localIso(2026, 3, 27),
            windowDurationMins: 10080,
          },
        },
        localIso(2026, 3, 25, 12),
      ),
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
      makeActivity(
        "activity-1",
        "account.rate-limits.updated",
        {
          rateLimitReachedType: null,
          secondary: {
            usedPercent: 50,
            resetsAt: localIso(2026, 3, 27),
            windowDurationMins: 10080,
          },
        },
        localIso(2026, 3, 25, 8),
      ),
    ]);

    const displayed = deriveDisplayedUsageLimitsSnapshot(
      snapshot,
      new Date(2026, 3, 25, 8).getTime(),
    );

    expect(displayed?.secondary?.elapsedPercent).toBeCloseTo((95.75 / 104.5) * 100);
    expect(displayed?.secondary?.projectedPercentAtReset).toBeCloseTo(50 / (95.75 / 104.5));
  });

  it("forecasts from the typical remainder of recent completed windows", () => {
    const durationMs = 7 * 24 * 60 * 60 * 1000;
    const currentResetMs = Date.parse("2026-08-20T08:15:00.000Z");
    const nowMs = currentResetMs - durationMs + 115 * 60 * 1000;
    const history = [
      { resetMs: currentResetMs - 3 * durationMs, usedAtNow: 2, finalUsed: 80 },
      { resetMs: currentResetMs - 2 * durationMs, usedAtNow: 6, finalUsed: 100 },
      { resetMs: currentResetMs - durationMs, usedAtNow: 4, finalUsed: 92 },
    ].map(({ resetMs, usedAtNow, finalUsed }) => ({
      resetsAt: new Date(resetMs).toISOString(),
      windowDurationMins: 10080,
      points: [
        {
          observedAt: new Date(resetMs - durationMs + 115 * 60 * 1000).toISOString(),
          usedPercent: usedAtNow,
        },
        { observedAt: new Date(resetMs - 60 * 1000).toISOString(), usedPercent: finalUsed },
      ],
    }));
    const snapshot = deriveLatestUsageLimitsSnapshotForSources([
      {
        provider: "codex",
        usageHistory: history,
        usageLimits: [
          {
            limitId: "codex",
            limitName: "Codex",
            planType: "pro",
            rateLimitReachedType: null,
            credits: null,
            primary: {
              usedPercent: 5,
              resetsAt: new Date(currentResetMs).toISOString(),
              windowDurationMins: 10080,
            },
            secondary: null,
            updatedAt: new Date(nowMs).toISOString(),
          },
        ],
      },
    ]);

    const displayed = deriveDisplayedUsageLimitsSnapshot(snapshot, nowMs)?.primary;

    expect(displayed?.projectedPercentAtReset).toBeCloseTo(103);
    expect(displayed?.projectionBasis).toBe("history");
    expect(displayed?.projectionConfidence).toBe("established");
    expect(displayed?.historicalWindowCount).toBe(3);
    expect(displayed?.projectedPercentRange?.low).toBeCloseTo(100.5);
    expect(displayed?.projectedPercentRange?.high).toBeCloseTo(104.5);
    expect(displayed?.depletionForecast.kind).toBe("beforeReset");
  });

  it("uses only the observed portion of an interrupted historical window", () => {
    const currentResetMs = new Date(2026, 2, 24, 15).getTime();
    const historicalResetMs = new Date(2026, 2, 23, 15).getTime();
    const nowMs = new Date(2026, 2, 24, 12, 30).getTime();
    const snapshot = deriveLatestUsageLimitsSnapshotForSources([
      {
        provider: "codex",
        usageHistory: [
          {
            resetsAt: new Date(historicalResetMs).toISOString(),
            windowDurationMins: 300,
            points: [
              {
                observedAt: new Date(2026, 2, 23, 12).toISOString(),
                usedPercent: 20,
              },
              {
                observedAt: new Date(2026, 2, 23, 13, 30).toISOString(),
                usedPercent: 35,
              },
            ],
          },
        ],
        usageLimits: [
          {
            limitId: "codex",
            limitName: "Codex",
            planType: "pro",
            rateLimitReachedType: null,
            credits: null,
            primary: {
              usedPercent: 40,
              resetsAt: new Date(currentResetMs).toISOString(),
              windowDurationMins: 300,
            },
            secondary: null,
            updatedAt: new Date(nowMs).toISOString(),
          },
        ],
      },
    ]);

    const displayed = deriveDisplayedUsageLimitsSnapshot(snapshot, nowMs)?.primary;

    expect(displayed?.projectedPercentAtReset).toBeCloseTo(79.87, 1);
    expect(displayed?.projectionBasis).toBe("history");
    expect(displayed?.projectionConfidence).toBe("early");
    expect(displayed?.historicalWindowCount).toBe(1);
    expect(displayed?.projectedPercentRange).toBeNull();
  });

  it("does not interpret history that ends before the current point as zero future usage", () => {
    const currentResetMs = new Date(2026, 2, 24, 15).getTime();
    const historicalResetMs = new Date(2026, 2, 23, 15).getTime();
    const nowMs = new Date(2026, 2, 24, 12, 30).getTime();
    const snapshot = deriveLatestUsageLimitsSnapshotForSources([
      {
        provider: "codex",
        usageHistory: [
          {
            resetsAt: new Date(historicalResetMs).toISOString(),
            windowDurationMins: 300,
            points: [
              {
                observedAt: new Date(2026, 2, 23, 11).toISOString(),
                usedPercent: 10,
              },
              {
                observedAt: new Date(2026, 2, 23, 12).toISOString(),
                usedPercent: 20,
              },
            ],
          },
        ],
        usageLimits: [
          {
            limitId: "codex",
            limitName: "Codex",
            planType: "pro",
            rateLimitReachedType: null,
            credits: null,
            primary: {
              usedPercent: 40,
              resetsAt: new Date(currentResetMs).toISOString(),
              windowDurationMins: 300,
            },
            secondary: null,
            updatedAt: new Date(nowMs).toISOString(),
          },
        ],
      },
    ]);

    const displayed = deriveDisplayedUsageLimitsSnapshot(snapshot, nowMs)?.primary;

    expect(displayed?.projectedPercentAtReset).toBe(80);
    expect(displayed?.projectionBasis).toBe("regularized");
    expect(displayed?.historicalWindowCount).toBe(0);
  });

  it("caps historical influence while preserving the depletion range", () => {
    const durationMs = 5 * 60 * 60 * 1000;
    const currentResetMs = new Date(2026, 2, 23, 15).getTime();
    const nowMs = new Date(2026, 2, 23, 12, 30).getTime();
    const history = [120, 130, 140].map((finalUsed, index) => {
      const resetMs = currentResetMs - (index + 1) * 24 * 60 * 60 * 1000;
      return {
        resetsAt: new Date(resetMs).toISOString(),
        windowDurationMins: 300,
        points: [
          {
            observedAt: new Date(resetMs - durationMs / 2).toISOString(),
            usedPercent: 60,
          },
          { observedAt: new Date(resetMs - 60 * 1000).toISOString(), usedPercent: finalUsed },
        ],
      };
    });
    const snapshot = deriveLatestUsageLimitsSnapshotForSources([
      {
        provider: "codex",
        usageHistory: history,
        usageLimits: [
          {
            limitId: "codex",
            limitName: "Codex",
            planType: "pro",
            rateLimitReachedType: null,
            credits: null,
            primary: {
              usedPercent: 60,
              resetsAt: new Date(currentResetMs).toISOString(),
              windowDurationMins: 300,
            },
            secondary: null,
            updatedAt: new Date(nowMs).toISOString(),
          },
        ],
      },
    ]);

    const displayed = deriveDisplayedUsageLimitsSnapshot(snapshot, nowMs)?.primary;

    expect(displayed?.projectedPercentAtReset).toBe(122.5);
    expect(displayed?.depletionForecast.kind).toBe("beforeReset");
    if (displayed?.depletionForecast.kind === "beforeReset") {
      expect(displayed.depletionForecast.estimatedAtMs).toBeCloseTo(
        new Date(2026, 2, 23, 14, 6).getTime(),
        -3,
      );
      expect(displayed.depletionForecast.range?.earliestAtMs).toBeCloseTo(
        new Date(2026, 2, 23, 14, 2, 18).getTime(),
        -3,
      );
      expect(displayed.depletionForecast.range?.latestAtMs).toBe(
        new Date(2026, 2, 23, 14, 10).getTime(),
      );
    }
  });

  it("regularizes an opening-window pace when no history exists", () => {
    const resetMs = Date.parse("2026-08-20T08:15:00.000Z");
    const nowMs = resetMs - 7 * 24 * 60 * 60 * 1000 + 115 * 60 * 1000;
    const snapshot = deriveLatestUsageLimitsSnapshot([
      makeActivity(
        "activity-early",
        "account.rate-limits.updated",
        {
          primary: {
            usedPercent: 5,
            resetsAt: new Date(resetMs).toISOString(),
            windowDurationMins: 10080,
          },
        },
        new Date(nowMs).toISOString(),
      ),
    ]);

    const displayed = deriveDisplayedUsageLimitsSnapshot(snapshot, nowMs)?.primary;

    expect(displayed?.projectedPercentAtReset).toBeGreaterThanOrEqual(95);
    expect(displayed?.projectedPercentAtReset).toBeLessThanOrEqual(115);
    expect(displayed?.projectionBasis).toBe("regularized");
    expect(displayed?.historicalWindowCount).toBe(0);
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
