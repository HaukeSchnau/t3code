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
});
