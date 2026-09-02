import { describe, expect, it } from "vite-plus/test";

import { appendUsageLimitObservation } from "./ProviderUsageHistory.ts";

describe("ProviderUsageHistory", () => {
  it("keeps same-duration keyed limits in separate histories", () => {
    const observedAt = "2026-08-21T12:00:00.000Z";
    const resetsAt = "2026-08-28T05:00:00.000Z";
    const allModels = appendUsageLimitObservation([], {
      windowKey: "weekly-all",
      observedAt,
      resetsAt,
      usedPercent: 13,
      windowDurationMins: 10080,
    });
    const result = appendUsageLimitObservation(allModels, {
      windowKey: "weekly-scoped:fable",
      observedAt,
      resetsAt,
      usedPercent: 4,
      windowDurationMins: 10080,
    });

    expect(result).toHaveLength(2);
    expect(result.map((window) => window.windowKey)).toEqual(["weekly-all", "weekly-scoped:fable"]);
    expect(result.map((window) => window.points[0]?.usedPercent)).toEqual([13, 4]);
  });

  it("keeps hourly unchanged observations as usage coverage", () => {
    const input = {
      windowKey: "session",
      resetsAt: "2026-08-21T17:00:00.000Z",
      windowDurationMins: 300,
    } as const;
    const initial = appendUsageLimitObservation([], {
      ...input,
      observedAt: "2026-08-21T12:00:00.000Z",
      usedPercent: 0,
    });
    const tooSoon = appendUsageLimitObservation(initial, {
      ...input,
      observedAt: "2026-08-21T12:30:00.000Z",
      usedPercent: 0,
    });
    const hourly = appendUsageLimitObservation(tooSoon, {
      ...input,
      observedAt: "2026-08-21T13:00:00.000Z",
      usedPercent: 0,
    });

    expect(initial[0]?.points).toEqual([
      { observedAt: "2026-08-21T12:00:00.000Z", usedPercent: 0 },
    ]);
    expect(tooSoon).toBe(initial);
    expect(hourly[0]?.points).toEqual([
      { observedAt: "2026-08-21T12:00:00.000Z", usedPercent: 0 },
      { observedAt: "2026-08-21T13:00:00.000Z", usedPercent: 0 },
    ]);
  });

  it("ignores lower usage from a stale observation", () => {
    const initial = appendUsageLimitObservation([], {
      windowKey: "session",
      observedAt: "2026-08-21T12:00:00.000Z",
      resetsAt: "2026-08-21T17:00:00.000Z",
      usedPercent: 30,
      windowDurationMins: 300,
    });
    const result = appendUsageLimitObservation(initial, {
      windowKey: "session",
      observedAt: "2026-08-21T14:00:00.000Z",
      resetsAt: "2026-08-21T17:00:00.000Z",
      usedPercent: 29,
      windowDurationMins: 300,
    });

    expect(result).toBe(initial);
  });
});
