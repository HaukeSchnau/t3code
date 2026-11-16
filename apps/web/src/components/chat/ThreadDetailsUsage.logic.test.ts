import {
  EnvironmentId,
  ProviderDriverKind,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { hubPoolFor } from "./ThreadDetailsUsage.logic";

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
