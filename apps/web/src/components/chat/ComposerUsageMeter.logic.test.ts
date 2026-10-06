import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { meterTone, meterWindows, windowShortLabel } from "./ComposerUsageMeter.logic";

const HOUR = 60 * 60 * 1000;
const now = Date.parse("2026-10-06T12:00:00Z");

function window(overrides: Partial<ServerProviderUsageWindow>): ServerProviderUsageWindow {
  return { id: "w", kind: "other", label: "Window", usedPercent: 0, ...overrides };
}

describe("meterWindows", () => {
  it("puts the session window before the weekly one, whatever the provider's order", () => {
    const weekly = window({ id: "seven_day", kind: "weekly" });
    const opus = window({ id: "seven_day_opus", kind: "weekly" });
    const session = window({ id: "five_hour", kind: "session" });
    expect(meterWindows([weekly, opus, session])).toEqual([session, weekly]);
  });

  it("fills in with the remaining windows when there is no session window", () => {
    const monthly = window({ id: "zai_mcp", kind: "monthly" });
    const weekly = window({ id: "zai_weekly", kind: "weekly" });
    expect(meterWindows([monthly, weekly])).toEqual([weekly, monthly]);
  });
});

describe("windowShortLabel", () => {
  it("names a window by its length", () => {
    expect(windowShortLabel(window({ windowDurationMins: 300 }))).toBe("5h");
    expect(windowShortLabel(window({ windowDurationMins: 7 * 24 * 60 }))).toBe("1w");
    expect(windowShortLabel(window({ windowDurationMins: 30 * 24 * 60 }))).toBe("30d");
    expect(windowShortLabel(window({ label: "Credits" }))).toBe("Credits");
  });
});

describe("meterTone", () => {
  const fiveHours = { windowDurationMins: 300 };
  // One hour into the five-hour window: even spending would have used 20%.
  const resetsAt = new Date(now + 4 * HOUR).toISOString();

  it("stays normal while spending keeps pace with the window", () => {
    expect(meterTone(window({ ...fiveHours, resetsAt, usedPercent: 22 }), now)).toBe("normal");
  });

  it("warns when spending runs ahead of the window", () => {
    expect(meterTone(window({ ...fiveHours, resetsAt, usedPercent: 40 }), now)).toBe("ahead");
  });

  it("marks a nearly spent window as low, even without a reset time", () => {
    expect(meterTone(window({ ...fiveHours, resetsAt, usedPercent: 95 }), now)).toBe("low");
    expect(meterTone(window({ usedPercent: 92 }), now)).toBe("low");
  });
});
