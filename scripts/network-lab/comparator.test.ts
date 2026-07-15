import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  BrowserNetworkLabMeasurement,
  CI_BROWSER_NETWORK_LAB_THRESHOLDS_V1,
  compareBrowserNetworkLabMeasurements,
} from "./comparator.ts";

const decode = Schema.decodeUnknownSync(BrowserNetworkLabMeasurement);
const identity = {
  scenario: { id: "direct.poor", version: 1 },
  profile: { id: "poor", version: 1 },
  provenance: {
    lab: { id: "network-lab", version: 1 },
    adapter: { id: "chromium", version: 1 },
  },
  seed: 17,
  executionId: "execution-17",
  definitionHash: "definition-17",
} as const;
let isolationGeneration = 0;

function measurement(variant: "baseline" | "candidate", overrides: Record<string, unknown> = {}) {
  isolationGeneration += 1;
  return decode({
    schemaVersion: 1,
    identity,
    variant,
    localAcceptanceMs: Array.from({ length: 20 }, (_, index) => 20 + index),
    statusVisibilityMs: [30, 35, 40, 45, 50],
    recoveryLatencyMs: 1_000,
    submissionCount: 1,
    commandCount: 1,
    effectCount: 1,
    semanticHash: "semantic",
    replayHash: "replay",
    cachedContentNonblank: true,
    connectionStatusVisible: true,
    recoveryObserved: true,
    faultSequence: ["poor-on:abc", "poor-off:def"],
    traffic: { bytesSent: 1_000, bytesReceived: 2_000, requestCount: 5, eventCount: 7 },
    faultEvidenceComplete: true,
    cleanupEvidenceComplete: true,
    isolation: {
      id: `${variant}-${isolationGeneration}`,
      executionId: identity.executionId,
      variant,
      exclusive: true,
    },
    ...overrides,
  });
}

describe("browser network-lab comparator", () => {
  it("passes matched correctness with bounded latency and traffic", () => {
    const result = compareBrowserNetworkLabMeasurements(
      measurement("baseline"),
      measurement("candidate", { recoveryLatencyMs: 2_000 }),
      measurement("candidate", { recoveryLatencyMs: 2_000 }),
    );

    assert.equal(result.status, "passed");
    assert.equal(result.metrics.localAcceptanceP95Ms, 38);
    assert.deepStrictEqual(result.failures, []);
  });

  it("fails absolute correctness before considering relative performance", () => {
    const result = compareBrowserNetworkLabMeasurements(
      measurement("baseline"),
      measurement("candidate", {
        commandCount: 2,
        effectCount: 2,
        semanticHash: "wrong",
        replayHash: "wrong",
        cachedContentNonblank: false,
        connectionStatusVisible: false,
      }),
      measurement("candidate"),
    );

    assert.equal(result.status, "failed");
    assert.deepStrictEqual(
      result.failures.map(({ id }) => id),
      [
        "correctness.candidate.cached-content",
        "correctness.candidate.connection-status",
        "correctness.candidate.command-count",
        "correctness.candidate.effect-count",
        "correctness.candidate.semantic-hash",
        "correctness.candidate.replay-hash",
        "reproducibility.correctness-counts",
      ],
    );
  });

  it("fails closed when fault or cleanup evidence is missing", () => {
    const result = compareBrowserNetworkLabMeasurements(
      measurement("baseline"),
      measurement("candidate", { faultEvidenceComplete: false, cleanupEvidenceComplete: false }),
      measurement("candidate", { faultEvidenceComplete: false, cleanupEvidenceComplete: false }),
    );

    assert.equal(result.status, "failed");
    assert.ok(result.failures.some(({ id }) => id === "candidate.fault-evidence"));
    assert.ok(result.failures.some(({ id }) => id === "repeat.cleanup-evidence"));
  });

  it("rejects identity drift and a non-reproducible fault sequence", () => {
    const repeated = measurement("candidate", {
      identity: { ...identity, seed: 18 },
      faultSequence: ["different"],
    });
    const result = compareBrowserNetworkLabMeasurements(
      measurement("baseline"),
      measurement("candidate"),
      repeated,
    );

    assert.equal(result.status, "failed");
    assert.ok(result.failures.some(({ id }) => id === "identity.candidate-repeat"));
    assert.ok(result.failures.some(({ id }) => id === "reproducibility.fault-sequence"));
  });

  it("uses p95 rather than averages and enforces relative recovery and traffic ceilings", () => {
    const candidate = measurement("candidate", {
      localAcceptanceMs: [...Array.from({ length: 18 }, () => 1), 151, 151],
      statusVisibilityMs: [1, 1, 1, 301, 301],
      recoveryLatencyMs: 2_251,
      traffic: {
        bytesSent: 66_787,
        bytesReceived: 68_037,
        requestCount: 12,
        eventCount: 14,
      },
    });
    const result = compareBrowserNetworkLabMeasurements(
      measurement("baseline"),
      candidate,
      measurement("candidate"),
      CI_BROWSER_NETWORK_LAB_THRESHOLDS_V1,
    );

    assert.equal(result.status, "failed");
    assert.deepStrictEqual(
      result.failures.map(({ id }) => id),
      [
        "latency.offline-acceptance-p95-ms",
        "latency.status-visibility-p95-ms",
        "latency.recovery-ms",
        "traffic.bytes-sent",
        "traffic.bytes-received",
        "traffic.requests",
        "traffic.events",
      ],
    );
  });

  it("rejects empty samples and non-finite timings at the artifact boundary", () => {
    assert.throws(() => measurement("candidate", { localAcceptanceMs: [] }));
    assert.throws(() => measurement("candidate", { recoveryLatencyMs: Number.NaN }));
  });

  it("does not label undersampled timings as p95 evidence", () => {
    const result = compareBrowserNetworkLabMeasurements(
      measurement("baseline", { localAcceptanceMs: [40], statusVisibilityMs: [50] }),
      measurement("candidate", { localAcceptanceMs: [40], statusVisibilityMs: [50] }),
      measurement("candidate", { localAcceptanceMs: [40], statusVisibilityMs: [50] }),
    );
    assert.equal(result.status, "failed");
    assert.deepStrictEqual(
      result.failures.filter(({ id }) => id.startsWith("samples.")).map(({ id }) => id),
      [
        "samples.baseline.offline-acceptance",
        "samples.baseline.status-visibility",
        "samples.candidate.offline-acceptance",
        "samples.candidate.status-visibility",
        "samples.repeat.offline-acceptance",
        "samples.repeat.status-visibility",
      ],
    );
  });
});
