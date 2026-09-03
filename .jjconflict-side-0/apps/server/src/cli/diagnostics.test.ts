import { assert, describe, it } from "@effect/vitest";

import { formatWorkloadDiagnosticsResult } from "./diagnostics.ts";

const snapshot = {
  schemaVersion: 1 as const,
  startedAtIso: "2026-07-13T00:00:00.000Z",
  readAtIso: "2026-07-13T00:00:01.000Z",
  counters: {
    "provider.events.received": 9_200,
    "provider_log.sampled_suppressed": 9_157,
  },
  gauges: {
    "subscriptions.detail.active": 0,
  },
};

describe("diagnostics CLI formatting", () => {
  it("emits one parseable workload JSON document", () => {
    const output = formatWorkloadDiagnosticsResult(snapshot, { json: true });
    assert.deepEqual(JSON.parse(output), snapshot);
  });

  it("omits zero gauges from concise workload output", () => {
    const output = formatWorkloadDiagnosticsResult(snapshot, { json: false });
    assert.include(output, "provider.events.received: 9200");
    assert.notInclude(output, "subscriptions.detail.active");
  });
});
