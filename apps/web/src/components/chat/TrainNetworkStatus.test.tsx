import type { EnvironmentConnectionFreshnessProjection } from "@t3tools/client-runtime/state/connection-freshness";
import { act } from "react";
import type { ReactTestRenderer } from "react-test-renderer";
import TestRenderer from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { TrainNetworkStatus } from "./TrainNetworkStatus";
import { NETWORK_DEGRADATION_HOLD_MS, NETWORK_RECOVERY_HOLD_MS } from "./trainNetworkExperience";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
});

const { create } = TestRenderer;

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

function visibleStatus(renderer: ReactTestRenderer): string | undefined {
  return renderer.root.findAll((node) => node.props["data-train-network-status"] !== undefined)[0]
    ?.props["data-train-network-status"];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("TrainNetworkStatus mounted timing", () => {
  it("mounts degradation only after the 250ms anti-flicker hold", async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<TrainNetworkStatus projection={offline} />);
    });

    expect(visibleStatus(renderer!)).toBeUndefined();
    await act(async () => vi.advanceTimersByTime(NETWORK_DEGRADATION_HOLD_MS - 1));
    expect(visibleStatus(renderer!)).toBeUndefined();
    await act(async () => vi.advanceTimersByTime(1));
    expect(visibleStatus(renderer!)).toBe("degraded");

    await act(async () => renderer!.unmount());
  });

  it("mounts recovery immediately and keeps it visible for exactly 500ms", async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<TrainNetworkStatus projection={offline} />);
      vi.advanceTimersByTime(NETWORK_DEGRADATION_HOLD_MS);
    });
    await act(async () => vi.advanceTimersByTime(NETWORK_DEGRADATION_HOLD_MS));
    expect(visibleStatus(renderer!)).toBe("degraded");

    await act(async () => renderer!.update(<TrainNetworkStatus projection={live} />));
    expect(visibleStatus(renderer!)).toBe("recovered");
    await act(async () => vi.advanceTimersByTime(NETWORK_RECOVERY_HOLD_MS - 1));
    expect(visibleStatus(renderer!)).toBe("recovered");
    await act(async () => vi.advanceTimersByTime(1));
    expect(visibleStatus(renderer!)).toBeUndefined();

    await act(async () => renderer!.unmount());
  });

  it("clears reconnecting quietly until the cached snapshot becomes live", async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<TrainNetworkStatus projection={offline} />);
    });
    await act(async () => vi.advanceTimersByTime(NETWORK_DEGRADATION_HOLD_MS));
    expect(visibleStatus(renderer!)).toBe("degraded");

    await act(async () => renderer!.update(<TrainNetworkStatus projection={synchronizing} />));
    expect(visibleStatus(renderer!)).toBeUndefined();

    await act(async () => renderer!.update(<TrainNetworkStatus projection={live} />));
    expect(visibleStatus(renderer!)).toBe("recovered");

    await act(async () => renderer!.unmount());
  });

  it("cleans pending hold timers when unmounted", async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<TrainNetworkStatus projection={offline} />);
    });
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => renderer!.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });
});
