import * as Schema from "effect/Schema";

import { NonEmptyString, NonNegativeInt, PositiveInt, RunIdentity } from "./model.ts";

export const NETWORK_LAB_COMPARISON_SCHEMA_VERSION = 1 as const;

const FiniteNonNegative = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));

export const BrowserTrafficMetrics = Schema.Struct({
  bytesSent: NonNegativeInt,
  bytesReceived: NonNegativeInt,
  requestCount: NonNegativeInt,
  eventCount: NonNegativeInt,
});
export type BrowserTrafficMetrics = typeof BrowserTrafficMetrics.Type;

export const BrowserNetworkLabMeasurement = Schema.Struct({
  schemaVersion: Schema.Literal(NETWORK_LAB_COMPARISON_SCHEMA_VERSION),
  identity: RunIdentity,
  variant: Schema.Literals(["baseline", "candidate"]),
  localAcceptanceMs: Schema.Array(FiniteNonNegative).check(Schema.isMinLength(1)),
  statusVisibilityMs: Schema.Array(FiniteNonNegative).check(Schema.isMinLength(1)),
  recoveryLatencyMs: FiniteNonNegative,
  submissionCount: PositiveInt,
  commandCount: NonNegativeInt,
  effectCount: NonNegativeInt,
  semanticHash: NonEmptyString,
  replayHash: NonEmptyString,
  cachedContentNonblank: Schema.Boolean,
  connectionStatusVisible: Schema.Boolean,
  recoveryObserved: Schema.Boolean,
  faultSequence: Schema.Array(NonEmptyString).check(Schema.isMinLength(1)),
  traffic: BrowserTrafficMetrics,
  faultEvidenceComplete: Schema.Boolean,
  cleanupEvidenceComplete: Schema.Boolean,
  isolation: Schema.Struct({
    id: NonEmptyString,
    executionId: NonEmptyString,
    variant: Schema.Literals(["baseline", "candidate"]),
    exclusive: Schema.Literal(true),
  }),
});
export type BrowserNetworkLabMeasurement = typeof BrowserNetworkLabMeasurement.Type;

export const BrowserNetworkLabThresholds = Schema.Struct({
  schemaVersion: Schema.Literal(NETWORK_LAB_COMPARISON_SCHEMA_VERSION),
  identity: Schema.Struct({ id: NonEmptyString, version: PositiveInt }),
  offlineAcceptanceP95Ms: FiniteNonNegative,
  statusVisibilityP95Ms: FiniteNonNegative,
  minimumAcceptanceSamples: PositiveInt,
  minimumStatusSamples: PositiveInt,
  recovery: Schema.Struct({ maxRatio: FiniteNonNegative, allowanceMs: FiniteNonNegative }),
  traffic: Schema.Struct({
    maxRatio: FiniteNonNegative,
    bytesAllowance: NonNegativeInt,
    requestAllowance: NonNegativeInt,
    eventAllowance: NonNegativeInt,
  }),
});
export type BrowserNetworkLabThresholds = typeof BrowserNetworkLabThresholds.Type;

export const CI_BROWSER_NETWORK_LAB_THRESHOLDS_V1 = {
  schemaVersion: 1,
  identity: { id: "direct-browser-ci", version: 1 },
  offlineAcceptanceP95Ms: 150,
  statusVisibilityP95Ms: 300,
  minimumAcceptanceSamples: 20,
  minimumStatusSamples: 5,
  recovery: { maxRatio: 1.25, allowanceMs: 1_000 },
  traffic: {
    maxRatio: 1.25,
    bytesAllowance: 65_536,
    requestAllowance: 5,
    eventAllowance: 5,
  },
} as const satisfies BrowserNetworkLabThresholds;

export interface BrowserComparisonFailure {
  readonly id: string;
  readonly expected: string | number | boolean;
  readonly observed: string | number | boolean;
}

export interface BrowserNetworkLabComparison {
  readonly schemaVersion: typeof NETWORK_LAB_COMPARISON_SCHEMA_VERSION;
  readonly status: "passed" | "failed";
  readonly identity: RunIdentity;
  readonly thresholds: BrowserNetworkLabThresholds["identity"];
  readonly metrics: {
    readonly localAcceptanceP95Ms: number;
    readonly statusVisibilityP95Ms: number;
    readonly recoveryLatencyRatio: number;
  };
  readonly failures: ReadonlyArray<BrowserComparisonFailure>;
}

function percentile95(samples: ReadonlyArray<number>): number {
  const ordered = samples.toSorted((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] ?? Number.POSITIVE_INFINITY;
}

function boundedRelative(
  candidate: number,
  baseline: number,
  ratio: number,
  allowance: number,
): boolean {
  return candidate <= baseline * ratio + allowance;
}

function sameIdentity(left: RunIdentity, right: RunIdentity): boolean {
  return (
    left.scenario.id === right.scenario.id &&
    left.scenario.version === right.scenario.version &&
    left.profile.id === right.profile.id &&
    left.profile.version === right.profile.version &&
    left.seed === right.seed &&
    left.definitionHash === right.definitionHash &&
    left.provenance.lab.id === right.provenance.lab.id &&
    left.provenance.lab.version === right.provenance.lab.version &&
    left.provenance.adapter.id === right.provenance.adapter.id &&
    left.provenance.adapter.version === right.provenance.adapter.version
  );
}

export function compareBrowserNetworkLabMeasurements(
  baseline: BrowserNetworkLabMeasurement,
  candidate: BrowserNetworkLabMeasurement,
  repeatedCandidate: BrowserNetworkLabMeasurement,
  thresholds: BrowserNetworkLabThresholds = CI_BROWSER_NETWORK_LAB_THRESHOLDS_V1,
): BrowserNetworkLabComparison {
  const failures: Array<BrowserComparisonFailure> = [];
  const fail = (
    id: string,
    expected: string | number | boolean,
    observed: string | number | boolean,
  ) => failures.push({ id, expected, observed });

  if (baseline.variant !== "baseline") fail("baseline.variant", "baseline", baseline.variant);
  if (candidate.variant !== "candidate") fail("candidate.variant", "candidate", candidate.variant);
  if (!sameIdentity(baseline.identity, candidate.identity)) {
    fail("identity.baseline-candidate", true, false);
  }
  if (!sameIdentity(candidate.identity, repeatedCandidate.identity)) {
    fail("identity.candidate-repeat", true, false);
  }
  if (candidate.faultSequence.join("\u0000") !== repeatedCandidate.faultSequence.join("\u0000")) {
    fail(
      "reproducibility.fault-sequence",
      candidate.faultSequence.join(","),
      repeatedCandidate.faultSequence.join(","),
    );
  }
  if (new Set([baseline.isolation.id, candidate.isolation.id, repeatedCandidate.isolation.id]).size !== 3) {
    fail("isolation.unique-runs", "three distinct isolation ids", "reused isolation id");
  }
  for (const [name, measurement] of [
    ["baseline", baseline],
    ["candidate", candidate],
    ["repeat", repeatedCandidate],
  ] as const) {
    if (
      measurement.isolation.executionId !== measurement.identity.executionId ||
      measurement.isolation.variant !== measurement.variant ||
      !measurement.isolation.exclusive
    ) {
      fail(`isolation.${name}`, true, false);
    }
  }
  for (const [name, value] of [
    ["baseline.fault-evidence", baseline.faultEvidenceComplete],
    ["candidate.fault-evidence", candidate.faultEvidenceComplete],
    ["repeat.fault-evidence", repeatedCandidate.faultEvidenceComplete],
    ["baseline.cleanup-evidence", baseline.cleanupEvidenceComplete],
    ["candidate.cleanup-evidence", candidate.cleanupEvidenceComplete],
    ["repeat.cleanup-evidence", repeatedCandidate.cleanupEvidenceComplete],
  ] as const) {
    if (!value) fail(name, true, value);
  }

  for (const [name, measurement] of [
    ["baseline", baseline],
    ["candidate", candidate],
    ["repeat", repeatedCandidate],
  ] as const) {
    if (!measurement.cachedContentNonblank) fail(`correctness.${name}.cached-content`, true, false);
    if (!measurement.connectionStatusVisible) fail(`correctness.${name}.connection-status`, true, false);
    if (!measurement.recoveryObserved) fail(`correctness.${name}.recovery-observed`, true, false);
    if (measurement.commandCount !== measurement.submissionCount) {
      fail(`correctness.${name}.command-count`, measurement.submissionCount, measurement.commandCount);
    }
    if (measurement.effectCount !== measurement.submissionCount) {
      fail(`correctness.${name}.effect-count`, measurement.submissionCount, measurement.effectCount);
    }
    if (measurement.semanticHash !== baseline.semanticHash) {
      fail(`correctness.${name}.semantic-hash`, baseline.semanticHash, measurement.semanticHash);
    }
    if (measurement.replayHash !== baseline.replayHash) {
      fail(`correctness.${name}.replay-hash`, baseline.replayHash, measurement.replayHash);
    }
  }
  if (
    candidate.submissionCount !== repeatedCandidate.submissionCount ||
    candidate.commandCount !== repeatedCandidate.commandCount ||
    candidate.effectCount !== repeatedCandidate.effectCount
  ) {
    fail("reproducibility.correctness-counts", true, false);
  }

  const localAcceptanceP95Ms = percentile95(candidate.localAcceptanceMs);
  const statusVisibilityP95Ms = percentile95(candidate.statusVisibilityMs);
  for (const [name, measurement] of [
    ["baseline", baseline],
    ["candidate", candidate],
    ["repeat", repeatedCandidate],
  ] as const) {
    if (measurement.localAcceptanceMs.length < thresholds.minimumAcceptanceSamples) {
      fail(
        `samples.${name}.offline-acceptance`,
        thresholds.minimumAcceptanceSamples,
        measurement.localAcceptanceMs.length,
      );
    }
    if (measurement.statusVisibilityMs.length < thresholds.minimumStatusSamples) {
      fail(
        `samples.${name}.status-visibility`,
        thresholds.minimumStatusSamples,
        measurement.statusVisibilityMs.length,
      );
    }
  }
  if (localAcceptanceP95Ms > thresholds.offlineAcceptanceP95Ms) {
    fail(
      "latency.offline-acceptance-p95-ms",
      thresholds.offlineAcceptanceP95Ms,
      localAcceptanceP95Ms,
    );
  }
  if (statusVisibilityP95Ms > thresholds.statusVisibilityP95Ms) {
    fail(
      "latency.status-visibility-p95-ms",
      thresholds.statusVisibilityP95Ms,
      statusVisibilityP95Ms,
    );
  }
  const repeatedAcceptanceP95Ms = percentile95(repeatedCandidate.localAcceptanceMs);
  const repeatedStatusP95Ms = percentile95(repeatedCandidate.statusVisibilityMs);
  if (repeatedAcceptanceP95Ms > thresholds.offlineAcceptanceP95Ms) {
    fail("latency.repeat.offline-acceptance-p95-ms", thresholds.offlineAcceptanceP95Ms, repeatedAcceptanceP95Ms);
  }
  if (repeatedStatusP95Ms > thresholds.statusVisibilityP95Ms) {
    fail("latency.repeat.status-visibility-p95-ms", thresholds.statusVisibilityP95Ms, repeatedStatusP95Ms);
  }
  if (
    !boundedRelative(
      candidate.recoveryLatencyMs,
      baseline.recoveryLatencyMs,
      thresholds.recovery.maxRatio,
      thresholds.recovery.allowanceMs,
    )
  ) {
    fail(
      "latency.recovery-ms",
      baseline.recoveryLatencyMs * thresholds.recovery.maxRatio + thresholds.recovery.allowanceMs,
      candidate.recoveryLatencyMs,
    );
  }
  if (
    !boundedRelative(
      repeatedCandidate.recoveryLatencyMs,
      baseline.recoveryLatencyMs,
      thresholds.recovery.maxRatio,
      thresholds.recovery.allowanceMs,
    )
  ) {
    fail(
      "latency.repeat.recovery-ms",
      baseline.recoveryLatencyMs * thresholds.recovery.maxRatio + thresholds.recovery.allowanceMs,
      repeatedCandidate.recoveryLatencyMs,
    );
  }

  for (const [name, candidateValue, baselineValue, allowance] of [
    [
      "bytes-sent",
      candidate.traffic.bytesSent,
      baseline.traffic.bytesSent,
      thresholds.traffic.bytesAllowance,
    ],
    [
      "bytes-received",
      candidate.traffic.bytesReceived,
      baseline.traffic.bytesReceived,
      thresholds.traffic.bytesAllowance,
    ],
    [
      "requests",
      candidate.traffic.requestCount,
      baseline.traffic.requestCount,
      thresholds.traffic.requestAllowance,
    ],
    [
      "events",
      candidate.traffic.eventCount,
      baseline.traffic.eventCount,
      thresholds.traffic.eventAllowance,
    ],
  ] as const) {
    const maximum = baselineValue * thresholds.traffic.maxRatio + allowance;
    if (candidateValue > maximum) fail(`traffic.${name}`, maximum, candidateValue);
  }
  for (const [name, repeatValue, baselineValue, allowance] of [
    ["bytes-sent", repeatedCandidate.traffic.bytesSent, baseline.traffic.bytesSent, thresholds.traffic.bytesAllowance],
    ["bytes-received", repeatedCandidate.traffic.bytesReceived, baseline.traffic.bytesReceived, thresholds.traffic.bytesAllowance],
    ["requests", repeatedCandidate.traffic.requestCount, baseline.traffic.requestCount, thresholds.traffic.requestAllowance],
    ["events", repeatedCandidate.traffic.eventCount, baseline.traffic.eventCount, thresholds.traffic.eventAllowance],
  ] as const) {
    const maximum = baselineValue * thresholds.traffic.maxRatio + allowance;
    if (repeatValue > maximum) fail(`traffic.repeat.${name}`, maximum, repeatValue);
  }

  return {
    schemaVersion: NETWORK_LAB_COMPARISON_SCHEMA_VERSION,
    status: failures.length === 0 ? "passed" : "failed",
    identity: candidate.identity,
    thresholds: thresholds.identity,
    metrics: {
      localAcceptanceP95Ms,
      statusVisibilityP95Ms,
      recoveryLatencyRatio:
        baseline.recoveryLatencyMs === 0
          ? candidate.recoveryLatencyMs === 0
            ? 1
            : Number.POSITIVE_INFINITY
          : candidate.recoveryLatencyMs / baseline.recoveryLatencyMs,
    },
    failures,
  };
}
