import type { EnvironmentConnectionFreshnessProjection } from "@t3tools/client-runtime/state/connection-freshness";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

let container: HTMLDivElement;
let root: Root;

const render = (element: ReactElement) => act(async () => root.render(element));
const visibleStatus = () =>
  container.querySelector("[data-train-network-status]")?.getAttribute("data-train-network-status");

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("TrainNetworkStatus mounted timing", () => {
  it("mounts degradation only after the 250ms anti-flicker hold", async () => {
    await render(<TrainNetworkStatus projection={offline} />);

    expect(visibleStatus()).toBeUndefined();
    await act(async () => vi.advanceTimersByTime(NETWORK_DEGRADATION_HOLD_MS - 1));
    expect(visibleStatus()).toBeUndefined();
    await act(async () => vi.advanceTimersByTime(1));
    expect(visibleStatus()).toBe("degraded");
  });

  it("mounts recovery immediately and keeps it visible for exactly 500ms", async () => {
    await render(<TrainNetworkStatus projection={offline} />);
    await act(async () => vi.advanceTimersByTime(NETWORK_DEGRADATION_HOLD_MS));
    expect(visibleStatus()).toBe("degraded");

    await render(<TrainNetworkStatus projection={live} />);
    expect(visibleStatus()).toBe("recovered");
    await act(async () => vi.advanceTimersByTime(NETWORK_RECOVERY_HOLD_MS - 1));
    expect(visibleStatus()).toBe("recovered");
    await act(async () => vi.advanceTimersByTime(1));
    expect(visibleStatus()).toBeUndefined();
  });

  it("clears reconnecting quietly until the cached snapshot becomes live", async () => {
    await render(<TrainNetworkStatus projection={offline} />);
    await act(async () => vi.advanceTimersByTime(NETWORK_DEGRADATION_HOLD_MS));
    expect(visibleStatus()).toBe("degraded");

    await render(<TrainNetworkStatus projection={synchronizing} />);
    expect(visibleStatus()).toBeUndefined();

    await render(<TrainNetworkStatus projection={live} />);
    expect(visibleStatus()).toBe("recovered");
  });

  it("cleans pending hold timers when unmounted", async () => {
    await render(<TrainNetworkStatus projection={offline} />);
    const pendingWhileMounted = vi.getTimerCount();
    expect(pendingWhileMounted).toBeGreaterThan(0);
    await render(<></>);
    expect(vi.getTimerCount()).toBe(pendingWhileMounted - 1);
  });
});
