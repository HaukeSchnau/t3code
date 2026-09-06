import { describe, expect, it } from "vite-plus/test";

import { boundWatchEvents, makeWatchChangeGate, makeWatchFloodGate } from "./WatchRuntime.ts";

describe("durable watch event pacing", () => {
  it("ignores repeated snapshots while preserving transitions back to earlier states", () => {
    const changed = makeWatchChangeGate();
    expect(changed(["pending"])).toBe(true);
    expect(changed(["pending"])).toBe(false);
    expect(changed(["active"])).toBe(true);
    expect(changed(["pending"])).toBe(true);
  });
  it("bounds individual events and the combined batch", () => {
    const bounded = boundWatchEvents(["  first  ", "x".repeat(600), "y".repeat(3_000)]);

    expect(bounded?.[0]).toBe("first");
    expect(bounded?.[1]).toHaveLength(500);
    expect(bounded?.join("")).toHaveLength(1_005);
    expect(
      boundWatchEvents(Array.from({ length: 10 }, () => "z".repeat(500)))?.join(""),
    ).toHaveLength(3_000);
    expect(boundWatchEvents(["  ", "\n"])).toBeNull();
  });

  it("drops bursts before failing a source that overloads for thirty seconds", () => {
    const gate = makeWatchFloodGate();

    for (let index = 0; index < 10; index += 1) {
      expect(gate.accept(1_000)).toBe("accept");
    }
    expect(gate.accept(1_000)).toBe("drop");
    expect(gate.accept(30_999)).toBe("accept");

    const sustained = makeWatchFloodGate();
    for (let index = 0; index < 10; index += 1) sustained.accept(1_000);
    expect(sustained.accept(1_001)).toBe("drop");
    for (let now = 1_101; now < 31_001; now += 100) sustained.accept(now);
    expect(sustained.accept(31_001)).toBe("overloaded");
  });
});
