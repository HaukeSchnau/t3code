import type {
  NetworkFaultControl,
  PlannedScenarioStep,
  ScenarioControlStep,
  ScenarioExecutionPlan,
} from "./model.ts";
import type {
  BrowserNetworkLabComparison,
  BrowserNetworkLabMeasurement,
  BrowserNetworkLabThresholds,
  BrowserTrafficMetrics,
} from "./comparator.ts";
import {
  CI_BROWSER_NETWORK_LAB_THRESHOLDS_V1,
  compareBrowserNetworkLabMeasurements,
} from "./comparator.ts";
import { PRODUCTION_BROWSER_SELECTORS_V1 } from "./browser-matrix.ts";
import type {
  ProductionBrowserDriver,
  ProductionBrowserSubmissionEvidence,
} from "../lib/production-browser-driver.ts";

export interface BrowserOracleEvidence {
  readonly commandCount: number;
  readonly effectCount: number;
  readonly semanticHash: string;
  readonly replayHash: string;
}

export type BrowserSubmissionEvidence = ProductionBrowserSubmissionEvidence;

export interface BrowserFaultEvidence {
  readonly decisionToken: string;
  readonly effectiveControl: NetworkFaultControl;
  readonly mechanism: "chromium-cdp" | "external-protocol-suppression-adapter";
}

export interface BrowserFixtureIsolation {
  readonly id: string;
  readonly executionId: string;
  readonly variant: "baseline" | "candidate";
  readonly exclusive: true;
}

export type ProductionT3BrowserDriver = ProductionBrowserDriver<NetworkFaultControl>;

export interface ProductionT3BrowserFixture {
  readonly prepare: (
    plan: ScenarioExecutionPlan,
    variant: "baseline" | "candidate",
  ) => Promise<{
    readonly appUrl: string;
    readonly driver: ProductionT3BrowserDriver;
    readonly collectOracle: () => Promise<BrowserOracleEvidence>;
    readonly faultEvidence: () => Promise<ReadonlyArray<BrowserFaultEvidence>>;
    readonly isolation: BrowserFixtureIsolation;
    readonly cleanup: () => Promise<{ readonly complete: boolean; readonly details: string }>;
  }>;
  readonly cleanupPreparationFailure: (
    plan: ScenarioExecutionPlan,
    variant: "baseline" | "candidate",
    cause: unknown,
  ) => Promise<{ readonly complete: boolean; readonly details: string }>;
}

const SUBMIT_SELECTOR = 'button[aria-label="Save message for delivery"]';

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function verifyFaultEvidence(
  plan: ScenarioExecutionPlan,
  evidence: ReadonlyArray<BrowserFaultEvidence>,
): Array<string> {
  const expected = plan.steps.filter(
    (planned): planned is PlannedScenarioStep & { readonly step: ScenarioControlStep } =>
      planned.step.kind === "control",
  );
  if (evidence.length !== expected.length) {
    throw new Error(`Fault evidence count mismatch: expected ${expected.length}, observed ${evidence.length}.`);
  }
  return expected.map((planned, index) => {
    const observed = evidence[index];
    if (
      !observed ||
      observed.decisionToken !== planned.decisionToken ||
      canonicalize(observed.effectiveControl) !== canonicalize(planned.step.control) ||
      observed.mechanism !==
        (planned.step.control.kind === "protocol-suppression"
          ? "external-protocol-suppression-adapter"
          : "chromium-cdp")
    ) {
      throw new Error(`Fault evidence did not match planned control at sequence ${planned.sequence}.`);
    }
    return `${observed.decisionToken}:${observed.effectiveControl.kind}:${observed.mechanism}`;
  });
}

export async function runProductionT3BrowserScenario(
  plan: ScenarioExecutionPlan,
  variant: "baseline" | "candidate",
  fixture: ProductionT3BrowserFixture,
): Promise<BrowserNetworkLabMeasurement> {
  let prepared: Awaited<ReturnType<ProductionT3BrowserFixture["prepare"]>>;
  try {
    prepared = await fixture.prepare(plan, variant);
  } catch (cause) {
    const cleanup = await fixture.cleanupPreparationFailure(plan, variant, cause).catch(
      (cleanupCause) => ({ complete: false, details: String(cleanupCause) }),
    );
    if (!cleanup.complete) {
      throw new AggregateError(
        [cause, new Error(`Preparation rollback was incomplete: ${cleanup.details}`)],
        "Browser fixture preparation failed and rollback was incomplete.",
      );
    }
    throw cause;
  }
  const localAcceptanceMs: Array<number> = [];
  const statusVisibilityMs: Array<number> = [];
  const faultSequence: Array<string> = [];
  let cachedContentNonblank = false;
  let connectionStatusVisible = false;
  let recoveryObserved = false;
  let recoveryLatencyMs = 0;
  let faultEvidenceComplete = false;
  let browserCleanupComplete = false;
  let fixtureCleanupComplete = false;
  const cleanupFailures: Array<unknown> = [];
  let oracle: BrowserOracleEvidence | undefined;
  let executionError: unknown;
  let traffic: BrowserTrafficMetrics = {
    bytesSent: 0,
    bytesReceived: 0,
    requestCount: 0,
    eventCount: 0,
  };

  try {
    if (
      prepared.isolation.executionId !== plan.identity.executionId ||
      prepared.isolation.variant !== variant ||
      !prepared.isolation.exclusive ||
      prepared.isolation.id.length === 0
    ) {
      throw new Error("Browser fixture did not provide matching exclusive isolation metadata.");
    }
    await prepared.driver.navigate(prepared.appUrl);
    await prepared.driver.assertProductionSurface(PRODUCTION_BROWSER_SELECTORS_V1);
    cachedContentNonblank = await prepared.driver.cachedContentNonblank(
      PRODUCTION_BROWSER_SELECTORS_V1.cachedTimeline,
    );

    for (const plannedStep of plan.steps) {
      const step = plannedStep.step;
      if (step.kind === "control") {
        const observed = await prepared.driver.applyControl(
          step.control,
          plannedStep.decisionToken,
        );
        if (
          observed.decisionToken !== plannedStep.decisionToken ||
          canonicalize(observed.effectiveControl) !== canonicalize(step.control)
        ) {
          throw new Error(`Applied control evidence did not match plan step '${step.id}'.`);
        }
        continue;
      }
      if (step.kind === "checkpoint") {
        if (step.checkpoint === "browser.connection-status-visible") {
          statusVisibilityMs.push(
            await prepared.driver.waitForConnectionStatus(
              PRODUCTION_BROWSER_SELECTORS_V1.connectionStatus,
              step.timeoutMs,
            ),
          );
          connectionStatusVisible = true;
        } else if (step.checkpoint === "browser.recovered") {
          recoveryLatencyMs = await prepared.driver.waitForRecovery(
            PRODUCTION_BROWSER_SELECTORS_V1.connectionStatus,
            step.timeoutMs,
          );
          recoveryObserved = true;
        } else {
          throw new Error(`Unsupported browser checkpoint '${step.checkpoint}'.`);
        }
        continue;
      }
      if (step.action === "browser.composer.submit") {
        const text = step.parameters.text;
        if (typeof text !== "string" || text.length === 0) {
          throw new Error("browser.composer.submit requires nonempty text.");
        }
        const submission = await prepared.driver.submitComposer({
          composerSelector: PRODUCTION_BROWSER_SELECTORS_V1.composer,
          submitSelector: SUBMIT_SELECTOR,
          durableIntentSelector: PRODUCTION_BROWSER_SELECTORS_V1.durableIntent,
          text,
        });
        if (submission.text !== text || submission.commandId.length === 0) {
          throw new Error("Durable acceptance evidence was not correlated to the submitted message.");
        }
        localAcceptanceMs.push(submission.localAcceptanceMs);
      } else if (step.action === "browser.reload") {
        await prepared.driver.reload();
        if (
          !(await prepared.driver.cachedContentNonblank(
            PRODUCTION_BROWSER_SELECTORS_V1.cachedTimeline,
          ))
        ) {
          cachedContentNonblank = false;
        }
      } else {
        throw new Error(`Unsupported browser action '${step.action}'.`);
      }
    }

    if (localAcceptanceMs.length === 0) {
      throw new Error("A browser measurement requires at least one real composer submission.");
    }
    if (statusVisibilityMs.length === 0) {
      throw new Error("A browser measurement requires DOM-visible connection status evidence.");
    }
    if (!recoveryObserved) {
      throw new Error("A browser measurement requires an observed browser.recovered checkpoint.");
    }
    oracle = await prepared.collectOracle();
    faultSequence.push(...verifyFaultEvidence(plan, await prepared.faultEvidence()));
    faultEvidenceComplete = true;
    traffic = prepared.driver.traffic();
  } catch (cause) {
    executionError = cause;
  } finally {
    const [browserCleanup, fixtureCleanup] = await Promise.allSettled([
      prepared.driver.close(),
      prepared.cleanup(),
    ]);
    browserCleanupComplete = browserCleanup.status === "fulfilled" && browserCleanup.value.complete;
    fixtureCleanupComplete = fixtureCleanup.status === "fulfilled" && fixtureCleanup.value.complete;
    if (browserCleanup.status === "rejected") cleanupFailures.push(browserCleanup.reason);
    else if (!browserCleanup.value.complete) cleanupFailures.push(new Error(browserCleanup.value.details));
    if (fixtureCleanup.status === "rejected") cleanupFailures.push(fixtureCleanup.reason);
    else if (!fixtureCleanup.value.complete) cleanupFailures.push(new Error(fixtureCleanup.value.details));
  }

  if (!browserCleanupComplete || !fixtureCleanupComplete) {
    throw new AggregateError(
      executionError === undefined
        ? cleanupFailures
        : [executionError, ...cleanupFailures],
      "Browser scenario cleanup evidence was incomplete.",
    );
  }
  if (executionError !== undefined) throw executionError;
  if (!oracle) throw new Error("Browser oracle evidence was unavailable.");
  return {
    schemaVersion: 1,
    identity: plan.identity,
    variant,
    localAcceptanceMs,
    statusVisibilityMs,
    recoveryLatencyMs,
    submissionCount: localAcceptanceMs.length,
    ...oracle,
    cachedContentNonblank,
    connectionStatusVisible,
    recoveryObserved,
    faultSequence,
    traffic,
    faultEvidenceComplete,
    cleanupEvidenceComplete: browserCleanupComplete && fixtureCleanupComplete,
    isolation: prepared.isolation,
  };
}

export async function runProductionT3BrowserComparisonGate(input: {
  readonly plan: ScenarioExecutionPlan;
  readonly baselineFixture: ProductionT3BrowserFixture;
  readonly candidateFixture: ProductionT3BrowserFixture;
  readonly thresholds?: BrowserNetworkLabThresholds;
}): Promise<BrowserNetworkLabComparison> {
  const baseline = await runProductionT3BrowserScenario(
    input.plan,
    "baseline",
    input.baselineFixture,
  );
  const candidate = await runProductionT3BrowserScenario(
    input.plan,
    "candidate",
    input.candidateFixture,
  );
  const repeatedCandidate = await runProductionT3BrowserScenario(
    input.plan,
    "candidate",
    input.candidateFixture,
  );
  const comparison = compareBrowserNetworkLabMeasurements(
    baseline,
    candidate,
    repeatedCandidate,
    input.thresholds ?? CI_BROWSER_NETWORK_LAB_THRESHOLDS_V1,
  );
  if (comparison.status === "failed") {
    const details = comparison.failures.map(
      ({ id, expected, observed }) =>
        `${id}: expected ${String(expected)}, observed ${String(observed)}`,
    );
    throw new Error(`Browser network-lab comparison failed:\n${details.join("\n")}`);
  }
  return comparison;
}
