import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type UsageLimitSourceSnapshot,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  otherDriverPools,
  poolSources,
  resolveThreadDetailsLimits,
} from "./ThreadDetailsUsage.logic";

const now = Date.parse("2026-10-30T12:00:00.000Z");
const checkedAt = "2026-10-30T11:59:00.000Z";
const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("claudeAgent");

function limitsAt(usedPercent: number): ServerProviderUsageLimits {
  return {
    checkedAt,
    windows: [
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent,
        windowDurationMins: 300,
        resetsAt: "2026-10-30T13:17:00.000Z",
      },
    ],
  };
}

const unsupported: ServerProviderUsageLimits = {
  checkedAt,
  windows: [],
  unavailable: { reason: "unsupported" },
};

function claudeInstance(usageLimits: ServerProviderUsageLimits): ServerProvider {
  return {
    instanceId,
    driver: claude,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: {
      status: "authenticated",
      type: "customEndpoint",
      label: "Custom API endpoint",
      endpoint: "http://127.0.0.1:8317",
    },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits,
  };
}

interface HubAccountInput {
  readonly id: string;
  readonly driver?: ProviderDriverKind;
  readonly models?: readonly string[];
  readonly limits: ServerProviderUsageLimits;
}

function hub(
  label: string,
  accounts: readonly HubAccountInput[],
  origin = "http://127.0.0.1:8317",
): UsageLimitSourceSnapshot {
  return {
    id: UsageLimitSourceId.make(label),
    kind: "cliproxy",
    label,
    origin,
    checkedAt,
    accounts: accounts.map((account) => ({
      id: account.id,
      driver: account.driver ?? claude,
      ...(account.models ? { models: account.models } : {}),
      usageLimits: account.limits,
    })),
  };
}

function shown(
  own: ServerProviderUsageLimits,
  sources: readonly UsageLimitSourceSnapshot[],
  model: string | null,
) {
  const resolved = resolveThreadDetailsLimits(
    instanceId,
    model,
    [claudeInstance(own)],
    sources,
    now,
  );
  if (resolved?.kind !== "pool") return resolved;
  return {
    kind: resolved.kind,
    rows: resolved.windows.map((window) => ({
      label: window.label,
      left: window.remainingPercent,
      accounts: window.members.length,
      from: poolSources(window),
    })),
  };
}

describe("resolveThreadDetailsLimits", () => {
  it("keeps an instance's failed reading instead of a hub it is not sent to", () => {
    const failed: ServerProviderUsageLimits = {
      checkedAt,
      windows: [],
      unavailable: { reason: "probeFailed" },
    };
    const direct = { ...claudeInstance(failed), auth: { status: "authenticated" as const } };
    const elsewhere = claudeInstance(unsupported);
    const readableHub = hub("Hub", [{ id: "a.json", limits: limitsAt(20) }]);
    const otherHub = hub("Other", [{ id: "a.json", limits: limitsAt(20) }], "http://hub");
    expect(resolveThreadDetailsLimits(instanceId, null, [direct], [readableHub], now)).toEqual({
      kind: "instance",
      limits: failed,
    });
    expect(resolveThreadDetailsLimits(instanceId, null, [elsewhere], [otherHub], now)).toEqual({
      kind: "instance",
      limits: unsupported,
    });
  });

  it("pools only the accounts the hub routes the model to, even of another driver", () => {
    const sources = [
      hub("Hub", [
        { id: "a.json", models: ["claude-opus-5-5"], limits: limitsAt(10) },
        { id: "c.json", driver: codex, models: ["gpt-5.6-sol"], limits: limitsAt(30) },
      ]),
    ];
    expect(shown(unsupported, sources, "gpt-5.6-sol[1m]")).toEqual({
      kind: "pool",
      rows: [{ label: "Session", left: 70, accounts: 1, from: { hubs: ["Hub"], signedIn: false } }],
    });
  });
});

describe("otherDriverPools", () => {
  const provider = (driver: string, usageLimits: ServerProviderUsageLimits): ServerProvider => ({
    ...claudeInstance(usageLimits),
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    auth: { status: "authenticated" },
  });

  it("pools every driver but the thread's, from native logins and the hub alike", () => {
    const providers = [
      provider("claudeAgent", unsupported),
      provider("cursor", {
        checkedAt,
        windows: [{ id: "autoPercentUsed", kind: "session", label: "Auto", usedPercent: 25 }],
      }),
      provider("opencode", unsupported),
    ];
    const sources = [
      hub("Hub", [
        { id: "a.json", limits: limitsAt(70) },
        {
          id: "b.json",
          limits: { checkedAt, windows: [], unavailable: { reason: "probeFailed" } },
        },
        { id: "c.json", driver: codex, limits: limitsAt(0) },
      ]),
    ];
    const pools = (activeDriver: ProviderDriverKind | null) =>
      otherDriverPools(activeDriver, providers, sources, now).map((pool) => [
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
