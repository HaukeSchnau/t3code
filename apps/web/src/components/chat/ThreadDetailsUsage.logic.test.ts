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

import { hubPoolFor, otherDriverPools } from "./ThreadDetailsUsage.logic";

const now = Date.parse("2026-10-06T12:00:00Z");
const checkedAt = "2026-10-06T11:59:00.000Z";
const environmentId = EnvironmentId.make("env");
const claude = ProviderDriverKind.make("claudeAgent");

const session = (usedPercent: number): ServerProviderUsageWindow => ({
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent,
});
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
const apiKey: ServerProviderUsageLimits = {
  checkedAt,
  windows: [],
  unavailable: { reason: "unsupported" },
};

describe("hubPoolFor", () => {
  it("pools the hub's accounts of the driver when the provider cannot report its own", () => {
    const pool = hubPoolFor(environmentId, claude, apiKey, hub, now);
    expect(pool?.accounts.map((account) => account.email)).toEqual([
      "first@example.com",
      "second@example.com",
    ]);
    expect(pool?.windows.map((window) => [window.label, window.remainingPercent])).toEqual([
      ["Session", 30],
    ]);
  });

  it("leaves a failed read, an account with its own windows, and a missing hub alone", () => {
    const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
    expect(hubPoolFor(environmentId, claude, failed, hub, now)).toBeNull();
    expect(
      hubPoolFor(environmentId, claude, { checkedAt, windows: [session(10)] }, hub, now),
    ).toBeNull();
    expect(hubPoolFor(environmentId, claude, apiKey, [], now)).toBeNull();
  });
});

describe("otherDriverPools", () => {
  const provider = (driver: string, usageLimits: ServerProviderUsageLimits): ServerProvider => ({
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits,
  });

  it("pools every driver but the thread's, from native logins and the hub alike", () => {
    const providers = [
      provider("claudeAgent", apiKey),
      provider("cursor", { checkedAt, windows: [{ ...session(25), id: "autoPercentUsed" }] }),
      provider("opencode", apiKey),
    ];
    const pools = (activeDriver: ProviderDriverKind | null) =>
      otherDriverPools(environmentId, activeDriver, providers, hub, now).map((pool) => [
        pool.driver,
        pool.windows.map((window) => window.remainingPercent),
      ]);
    expect(pools(ProviderDriverKind.make("cursor"))).toEqual([
      ["claudeAgent", [30]],
      ["codex", [100]],
    ]);
    expect(pools(null)).toEqual([
      ["cursor", [75]],
      ["claudeAgent", [30]],
      ["codex", [100]],
    ]);
  });
});
