import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { measuredSpend, recordSpendSample, type SpendSample } from "./usageSpendHistory.ts";

const HOUR = 3_600_000;
const resetAt = (hours: number) => DateTime.formatIso(DateTime.makeUnsafe(hours * HOUR));
const weekly = (usedPercent: number, resetsInHours: number): ServerProviderUsageWindow => ({
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent,
  windowDurationMins: 7 * 24 * 60,
  resetsAt: resetAt(resetsInHours),
});

describe("measuredSpend", () => {
  it("adds what a new window used since its reset and ignores a drifting reset time", () => {
    const samples: SpendSample[] = [
      [0, 80, 20 * HOUR],
      [10 * HOUR, 90, 20 * HOUR + 30_000],
      // The window reset at 20h; the next reading sees 5% of the new week used.
      [30 * HOUR, 5, 188 * HOUR],
    ];
    expect(measuredSpend(samples, weekly(15, 188), 40 * HOUR)).toEqual({
      percentPerHour: (10 + 5 + 10) / 40,
      hours: 40,
    });
  });

  it("needs a day of readings", () => {
    expect(measuredSpend([[0, 10, null]], weekly(20, 100), 23 * HOUR)).toBeUndefined();
    expect(measuredSpend([], weekly(20, 100), 0)).toBeUndefined();
  });
});

describe("recordSpendSample", () => {
  it("keeps changes and an hourly reading, and one reading from before the last three days", () => {
    let samples: readonly SpendSample[] = [];
    samples = recordSpendSample(samples, weekly(10, 200), 0);
    samples = recordSpendSample(samples, weekly(10, 200), 0.5 * HOUR);
    expect(samples).toHaveLength(1);
    samples = recordSpendSample(samples, weekly(10, 200), 1.5 * HOUR);
    samples = recordSpendSample(samples, weekly(12, 200), 1.6 * HOUR);
    expect(samples.map(([at]) => at / HOUR)).toEqual([0, 1.5, 1.6]);

    samples = recordSpendSample(samples, weekly(30, 200), 80 * HOUR);
    expect(samples.map(([at]) => at / HOUR)).toEqual([1.6, 80]);
  });
});
