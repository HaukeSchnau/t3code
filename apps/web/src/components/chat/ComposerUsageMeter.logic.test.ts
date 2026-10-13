import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type MeterSource,
  meterRows,
  meterSource,
  meterWindows,
  windowShortLabel,
} from "./ComposerUsageMeter.logic";

const HOUR = 60 * 60 * 1000;
const now = Date.parse("2026-10-06T12:00:00Z");
const checkedAt = "2026-10-06T11:59:00.000Z";
const environmentId = EnvironmentId.make("env");
const claude = ProviderDriverKind.make("claudeAgent");

function window(overrides: Partial<ServerProviderUsageWindow>): ServerProviderUsageWindow {
  return { id: "w", kind: "other", label: "Window", usedPercent: 0, ...overrides };
}

function provider(usageLimits: ServerProviderUsageLimits): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claude"),
    driver: claude,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits,
  };
}

const session = (usedPercent: number) =>
  window({ id: "five_hour", kind: "session", label: "Session", usedPercent });
const hubAccount = (id: string, limits: Partial<ServerProviderUsageLimits>) => ({
  id,
  driver: claude,
  email: `${id}@example.com`,
  usageLimits: { checkedAt, windows: [], ...limits },
});
const hub = [
  {
    id: UsageLimitSourceId.make("hub"),
    kind: "cliproxy" as const,
    label: "Claude accounts",
    checkedAt,
    accounts: [
      hubAccount("first", { windows: [session(40)] }),
      hubAccount("second", { windows: [session(100)] }),
      hubAccount("throttled", { unavailable: { reason: "probeFailed" } }),
      {
        ...hubAccount("codex", { windows: [session(0)] }),
        driver: ProviderDriverKind.make("codex"),
      },
    ],
  },
];

describe("meterSource", () => {
  it("reads the provider's own windows when it reports them", () => {
    const own = provider({ checkedAt, windows: [session(10)] });
    expect(meterSource(environmentId, own, hub, now)).toEqual({
      kind: "account",
      windows: [session(10)],
    });
  });

  it("pools the hub's accounts of its driver when the provider cannot report its own", () => {
    const apiKey = provider({ checkedAt, windows: [], unavailable: { reason: "unsupported" } });
    const source = meterSource(environmentId, apiKey, hub, now);
    expect(source?.kind === "pool" ? source.pool.accounts.length : null).toBe(2);
    expect(meterRows(source!, now)).toEqual([
      { id: "five_hour", label: "Session", shortLabel: "Session", remaining: 30, tone: "normal" },
    ]);
  });

  it("shows nothing when the provider's own read failed or no hub reports its driver", () => {
    const failed = provider({ checkedAt, windows: [], unavailable: { reason: "probeFailed" } });
    const apiKey = provider({ checkedAt, windows: [], unavailable: { reason: "unsupported" } });
    expect(meterSource(environmentId, failed, hub, now)).toBeNull();
    expect(meterSource(environmentId, apiKey, [], now)).toBeNull();
  });
});

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

describe("meter tone", () => {
  const fiveHours = { windowDurationMins: 300 };
  // One hour into the five-hour window: even spending would have used 20%.
  const resetsAt = new Date(now + 4 * HOUR).toISOString();
  const tone = (overrides: Partial<ServerProviderUsageWindow>) => {
    const source: MeterSource = { kind: "account", windows: [window(overrides)] };
    return meterRows(source, now)[0]?.tone;
  };

  it("stays normal while spending keeps pace with the window", () => {
    expect(tone({ ...fiveHours, resetsAt, usedPercent: 22 })).toBe("normal");
  });

  it("warns when spending runs ahead of the window", () => {
    expect(tone({ ...fiveHours, resetsAt, usedPercent: 40 })).toBe("ahead");
  });

  it("marks a nearly spent window as low, even without a reset time", () => {
    expect(tone({ ...fiveHours, resetsAt, usedPercent: 95 })).toBe("low");
    expect(tone({ usedPercent: 92 })).toBe("low");
  });
});
