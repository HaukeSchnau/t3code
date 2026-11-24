import {
  EnvironmentId,
  type HostResourcesSnapshot,
  type PlacementReport,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { decidePlacement, type PlacementOption } from "./placement.ts";

const GiB = 1024 ** 3;
const now = 1_000_000;
const idle: HostResourcesSnapshot = {
  sampledAt: now,
  cpuUtilization: 0.1,
  cpuCount: 16,
  availableMemoryBytes: 10 * GiB,
  totalMemoryBytes: 32 * GiB,
  memoryPressure: { someAvg10: 0, someAvg60: 0 },
};

function option(
  label: string,
  overrides: Partial<PlacementReport> = {},
  extra: Partial<PlacementOption> = {},
): PlacementOption {
  const environmentId = EnvironmentId.make(label);
  return {
    environmentId,
    label,
    report: {
      environmentId,
      label,
      platform: "linux",
      weight: 100,
      agentLimit: null,
      resources: idle,
      runningAgents: 0,
      launchesInFlight: 0,
      waiting: 0,
      worlds: [],
      providers: [ProviderInstanceId.make("claude")],
      ...overrides,
    },
    receivedAt: now,
    sentLaunches: 0,
    warmth: 1,
    ...extra,
  };
}

describe("decidePlacement", () => {
  it("spreads a burst: launches sent to a machine count against it", () => {
    const roomy = option("srv-2", { resources: { ...idle, availableMemoryBytes: 6 * GiB } });
    const smaller = option("dev-hauke", {
      resources: { ...idle, availableMemoryBytes: 4.5 * GiB },
    });
    expect(decidePlacement([roomy, smaller], now)?.chosen.label).toBe("srv-2");
    const afterTwo = { ...roomy, sentLaunches: 2 };
    expect(decidePlacement([afterTwo, smaller], now)?.chosen.label).toBe("dev-hauke");
    // The machine's own report of launches in flight counts the same way.
    const reported = option("srv-2", {
      resources: { ...idle, availableMemoryBytes: 6 * GiB },
      launchesInFlight: 2,
    });
    expect(decidePlacement([reported, smaller], now)?.chosen.label).toBe("dev-hauke");
  });

  it("says which machine it passed over and why", () => {
    const pressured = option("srv-2", {
      resources: { ...idle, memoryPressure: { someAvg10: 84, someAvg60: 60 } },
    });
    const light = option("srv-1", { weight: 25 });
    const decision = decidePlacement([pressured, light], now);
    expect(decision?.chosen.label).toBe("srv-1");
    expect(decision?.wait).toBe(false);
    expect(decision?.reason).toBe("srv-2 at 84% memory pressure");
    expect(decision?.candidates.find((candidate) => candidate.label === "srv-2")).toMatchObject({
      admissible: false,
      score: 0,
    });
  });

  it("waits on the preferred machine when none has room, behind the fewest others", () => {
    const full = { agentLimit: 2, runningAgents: 2 };
    const busy = option("srv-2", { ...full, waiting: 3 });
    const quieter = option("dev-hauke", { ...full, waiting: 0 });
    const light = option("srv-1", { ...full, weight: 25 });
    const decision = decidePlacement([busy, quieter, light], now);
    expect(decision).toMatchObject({ wait: true, chosen: { label: "dev-hauke" } });
    expect(decision?.reason).toBe("no machine has room; dev-hauke at its limit of 2 agents");
    // Light pressure only lowers a machine's preference; its last free slot still takes work.
    const lastSlot = option("dev-hauke", {
      agentLimit: 2,
      runningAgents: 1,
      resources: { ...idle, memoryPressure: { someAvg10: 1, someAvg60: 0.3 } },
    });
    expect(decidePlacement([busy, lastSlot], now)).toMatchObject({
      wait: false,
      chosen: { label: "dev-hauke", slots: 1 },
    });
  });

  it("never picks a machine that cannot take the thread, even an idle one", () => {
    const mac = option("m1", {}, { warmth: { unavailable: "does not serve the schnau world" } });
    const stale = option("tower", {}, { receivedAt: now - 60_000 });
    const manual = option("srv-1", { weight: 0 });
    expect(decidePlacement([mac, stale, manual], now)).toBeNull();
    const busyWorldHost = option("srv-2", { agentLimit: 1, runningAgents: 1 });
    expect(decidePlacement([mac, busyWorldHost], now)).toMatchObject({
      wait: true,
      chosen: { label: "srv-2" },
    });
  });

  it("prefers a warm machine over a cold one with the same room", () => {
    const warm = option("dev-hauke");
    const cold = option("srv-2", {}, { warmth: 0.5 });
    expect(decidePlacement([cold, warm], now)?.chosen.label).toBe("dev-hauke");
  });
});
