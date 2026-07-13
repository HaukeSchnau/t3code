import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { WorkloadDiagnosticsSnapshot } from "@t3tools/contracts";
import { makeWorkloadDiagnosticsRegistry } from "./WorkloadDiagnostics.ts";

const isWorkloadDiagnosticsSnapshot = Schema.is(WorkloadDiagnosticsSnapshot);

describe("WorkloadDiagnostics", () => {
  it("records monotonic counters and bounded gauges in a schema-valid snapshot", () => {
    const registry = makeWorkloadDiagnosticsRegistry("2026-07-13T00:00:00.000Z");
    registry.increment("provider.events.received", 3);
    registry.increment("provider.delta.characters", 22_000_000);
    registry.adjustGauge("subscriptions.detail.active", 2);
    registry.adjustGauge("subscriptions.detail.active", -1);
    registry.adjustGauge("subscriptions.shell.active", -10);

    const snapshot = registry.snapshot();
    assert.equal(snapshot.counters["provider.events.received"], 3);
    assert.equal(snapshot.counters["provider.delta.characters"], 22_000_000);
    assert.equal(snapshot.gauges["subscriptions.detail.active"], 1);
    assert.equal(snapshot.gauges["subscriptions.shell.active"], 0);
    assert.equal(isWorkloadDiagnosticsSnapshot(snapshot), true);
  });

  it("returns copies so callers cannot mutate live counters", () => {
    const registry = makeWorkloadDiagnosticsRegistry();
    const first = registry.snapshot();
    (first.counters as Record<string, number>)["provider.events.received"] = 100;

    assert.equal(registry.snapshot().counters["provider.events.received"], 0);
  });
});
