import type { EnvironmentConnectionFreshnessProjection } from "@t3tools/client-runtime/state/connection-freshness";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render, type Screen } from "../../../test/render";

import { TrainNetworkStatus } from "./TrainNetworkStatus";
import { NETWORK_DEGRADATION_HOLD_MS, NETWORK_RECOVERY_HOLD_MS } from "./trainNetworkExperience";

const cachedSnapshot = {
  status: "cached" as const,
  snapshot: { contentSequence: 8, updatedAt: "2026-07-15T10:00:00.000Z" },
  error: null,
};

const offline: EnvironmentConnectionFreshnessProjection = {
  connection: {
    phase: "offline",
    stage: "waiting-for-network",
    attempt: 1,
    generation: 1,
    failure: null,
  },
  snapshot: cachedSnapshot,
};

const live: EnvironmentConnectionFreshnessProjection = {
  connection: {
    phase: "connected",
    stage: "ready",
    attempt: 2,
    generation: 2,
    failure: null,
  },
  snapshot: { ...cachedSnapshot, status: "live" },
};

const synchronizing: EnvironmentConnectionFreshnessProjection = {
  connection: live.connection,
  snapshot: { ...cachedSnapshot, status: "synchronizing" },
};

const visibleStatus = (screen: Screen) =>
  screen.container
    .querySelector("[data-train-network-status]")
    ?.getAttribute("data-train-network-status");
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("TrainNetworkStatus mounted timing", () => {
  it("mounts degradation only after the 250ms anti-flicker hold", async () => {
    using _timers = fakeTimers();
    await using screen = await render(<TrainNetworkStatus projection={offline} />);

    expect(visibleStatus(screen)).toBeUndefined();
    await advance(NETWORK_DEGRADATION_HOLD_MS - 1);
    expect(visibleStatus(screen)).toBeUndefined();
    await advance(1);
    expect(visibleStatus(screen)).toBe("degraded");
  });

  it("mounts recovery immediately and keeps it visible for exactly 500ms", async () => {
    using _timers = fakeTimers();
    await using screen = await render(<TrainNetworkStatus projection={offline} />);
    await advance(NETWORK_DEGRADATION_HOLD_MS);
    expect(visibleStatus(screen)).toBe("degraded");

    await screen.rerender(<TrainNetworkStatus projection={live} />);
    expect(visibleStatus(screen)).toBe("recovered");
    await advance(NETWORK_RECOVERY_HOLD_MS - 1);
    expect(visibleStatus(screen)).toBe("recovered");
    await advance(1);
    expect(visibleStatus(screen)).toBeUndefined();
  });

  it("clears reconnecting quietly until the cached snapshot becomes live", async () => {
    using _timers = fakeTimers();
    await using screen = await render(<TrainNetworkStatus projection={offline} />);
    await advance(NETWORK_DEGRADATION_HOLD_MS);
    expect(visibleStatus(screen)).toBe("degraded");

    await screen.rerender(<TrainNetworkStatus projection={synchronizing} />);
    expect(visibleStatus(screen)).toBeUndefined();

    await screen.rerender(<TrainNetworkStatus projection={live} />);
    expect(visibleStatus(screen)).toBe("recovered");
  });

  it("cleans pending hold timers when unmounted", async () => {
    using _timers = fakeTimers();
    await using screen = await render(<TrainNetworkStatus projection={offline} />);
    const pendingWhileMounted = vi.getTimerCount();
    expect(pendingWhileMounted).toBeGreaterThan(0);
    await screen.rerender(<></>);
    expect(vi.getTimerCount()).toBe(pendingWhileMounted - 1);
  });
});
