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
      [19.5 * HOUR, 95, 20 * HOUR],
      // The window reset at 20h; the next reading sees 3% of the new week used.
      [20.5 * HOUR, 3, 188 * HOUR],
    ];
    expect(measuredSpend(samples, weekly(15, 188), 40 * HOUR)).toEqual({
      percentPerHour: (10 + 5 + 3 + 12) / 40,
      hours: 40,
    });
  });

  it("counts only observed time: a long gap across a reset and an old reading don't dilute it", () => {
    const samples: SpendSample[] = [
      [0, 50, 120 * HOUR],
      [240 * HOUR, 30, 360 * HOUR],
      [252 * HOUR, 42, 360 * HOUR],
    ];
    expect(measuredSpend(samples, weekly(54, 360), 264 * HOUR)).toEqual({
      percentPerHour: 1,
      hours: 24,
    });
    // Only the part of an interval inside a five-hour window counts toward it.
    const session: ServerProviderUsageWindow = {
      ...weekly(30, 8),
      id: "five_hour",
      kind: "session",
      windowDurationMins: 300,
    };
    expect(
      measuredSpend(
        [
          [0, 10, 8 * HOUR],
          [2.5 * HOUR, 20, 8 * HOUR],
        ],
        session,
        7 * HOUR,
      ),
    ).toEqual({ percentPerHour: (2 + 10) / 5, hours: 5 });
  });

  it("reports how much of the window it observed, and a kept-over reading adds no time", () => {
    expect(measuredSpend([[0, 10, null]], weekly(20, 100), 23 * HOUR)).toEqual({
      percentPerHour: 10 / 23,
      hours: 23,
    });
    expect(
      measuredSpend([[0, 10, null]], { ...weekly(20, 100), windowDurationMins: undefined }, HOUR),
    ).toBeUndefined();
    expect(measuredSpend([], weekly(20, 100), 0)).toBeUndefined();
    const samples: SpendSample[] = [[0, 10, 100 * HOUR]];
    expect(recordSpendSample(samples, weekly(10, 100), 0)).toBe(samples);
    expect(measuredSpend(samples, weekly(10, 100), 0)).toBeUndefined();
  });
});

describe("recordSpendSample", () => {
  it("keeps changes and an hourly reading, and drops readings older than the window", () => {
    let samples: readonly SpendSample[] = [];
    samples = recordSpendSample(samples, weekly(10, 200), 0);
    samples = recordSpendSample(samples, weekly(10, 200), 0.5 * HOUR);
    expect(samples).toHaveLength(1);
    samples = recordSpendSample(samples, weekly(10, 200), 1.5 * HOUR);
    samples = recordSpendSample(samples, weekly(12, 200), 1.6 * HOUR);
    expect(samples.map(([at]) => at / HOUR)).toEqual([0, 1.5, 1.6]);

    samples = recordSpendSample(samples, weekly(30, 200), 75 * HOUR);
    expect(samples.map(([at]) => at / HOUR)).toEqual([0, 1.5, 1.6, 75]);
    samples = recordSpendSample(samples, weekly(40, 200), 171 * HOUR);
    expect(samples.map(([at]) => at / HOUR)).toEqual([1.5, 1.6, 75, 171]);
  });
});
