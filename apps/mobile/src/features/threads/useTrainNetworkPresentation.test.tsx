import { describe, expect, it, afterEach } from "@effect/vitest";
import { vi } from "vitest";
import type { EnvironmentConnectionFreshnessProjection } from "@t3tools/client-runtime/state/connection-freshness";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import { useTrainNetworkPresentation } from "./useTrainNetworkPresentation";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

vi.hoisted(() => {
  process.env.NODE_ENV = "development";
});

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SNAPSHOT = { contentSequence: 7, updatedAt: "2026-07-15T10:00:00.000Z" };
const LIVE: EnvironmentConnectionFreshnessProjection = {
  connection: {
    phase: "connected",
    stage: "ready",
    attempt: 1,
    generation: 1,
    failure: null,
  },
  snapshot: { status: "live", snapshot: SNAPSHOT, error: null },
};

function reconnecting(retryAt: number, attempt = 2): EnvironmentConnectionFreshnessProjection {
  return {
    connection: {
      phase: "reconnecting",
      stage: "waiting-to-retry",
      retryAt,
      attempt,
      generation: 2,
      failure: { reason: "transport", message: "connection dropped", traceId: null },
    },
    snapshot: { status: "cached", snapshot: SNAPSHOT, error: null },
  };
}

type ProbeValue = ReturnType<typeof useTrainNetworkPresentation>;
let latest: ProbeValue | null = null;
let accessibilityAnnouncements: string[] = [];

function Probe(props: {
  readonly projection: EnvironmentConnectionFreshnessProjection;
  readonly hasThreadContent?: boolean;
  readonly remoteQueueCount?: number;
}) {
  const value = useTrainNetworkPresentation({
    projection: props.projection,
    fallbackStatus: null,
    environmentLabel: "Workstation",
    hasThreadContent: props.hasThreadContent ?? true,
    remoteQueueCount: props.remoteQueueCount ?? 0,
  });
  latest = value;
  const announcement = value.connectionStatus?.accessibilityLabel;
  if (announcement && accessibilityAnnouncements.at(-1) !== announcement) {
    accessibilityAnnouncements.push(announcement);
  }
  return null;
}

afterEach(() => {
  vi.useRealTimers();
  latest = null;
  accessibilityAnnouncements = [];
});

describe("mounted mobile train network presentation", () => {
  it("waits 250ms before degradation and holds recovery for 500ms", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T10:00:00.000Z"));
    let renderer: ReactTestRenderer;
    act(() => void (renderer = create(<Probe projection={LIVE} />)));
    expect(latest?.connectionStatus).toBeNull();

    act(() => renderer.update(<Probe projection={reconnecting(Date.now() + 4_000)} />));
    act(() => vi.advanceTimersByTime(249));
    expect(latest?.connectionStatus).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(latest?.connectionStatus?.label).toContain("showing saved conversation");

    act(() => renderer.update(<Probe projection={LIVE} />));
    act(() => vi.advanceTimersByTime(499));
    expect(latest?.connectionStatus).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(latest?.connectionStatus).toBeNull();
    act(() => renderer.unmount());
  });

  it("cancels a stale degradation timer when transport recovers quickly", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T10:00:00.000Z"));
    let renderer: ReactTestRenderer;
    act(() => void (renderer = create(<Probe projection={LIVE} />)));
    act(() => renderer.update(<Probe projection={reconnecting(Date.now() + 4_000)} />));
    act(() => vi.advanceTimersByTime(100));
    act(() => renderer.update(<Probe projection={LIVE} />));
    act(() => vi.advanceTimersByTime(1_000));
    expect(latest?.connectionStatus).toBeNull();
    act(() => renderer.unmount());
  });

  it("updates the visual countdown without repeating polite announcements", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T10:00:00.000Z"));
    let renderer: ReactTestRenderer;
    act(() =>
      void (renderer = create(<Probe projection={reconnecting(Date.now() + 5_000, 3)} />)),
    );
    act(() => vi.advanceTimersByTime(250));
    expect(latest?.connectionStatus?.label).toContain("Retrying in 5s · attempt 3");
    const stableAnnouncement = latest?.connectionStatus?.accessibilityLabel;
    act(() => vi.advanceTimersByTime(2_000));
    expect(latest?.connectionStatus?.label).toContain("Retrying in 3s · attempt 3");
    expect(latest?.connectionStatus?.accessibilityLabel).toBe(stableAnnouncement);
    expect(accessibilityAnnouncements).toEqual([stableAnnouncement]);
    act(() => renderer.unmount());
  });

  it("retains cached-content wording and wires the detail remote queue independently", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T10:00:00.000Z"));
    let renderer: ReactTestRenderer;
    act(() =>
      void (renderer = create(
        <Probe
          projection={reconnecting(Date.now() + 4_000)}
          hasThreadContent
          remoteQueueCount={2}
        />,
      )),
    );
    act(() => vi.advanceTimersByTime(250));
    expect(latest?.connectionStatus?.label).toContain("showing saved conversation");
    expect(latest?.remoteQueueStatus).toBe(
      "Remote queue · 2 messages waiting behind current work",
    );
    act(() => renderer.unmount());
  });
});
