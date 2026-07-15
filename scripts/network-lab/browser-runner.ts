import type { NetworkFaultControl, ScenarioExecutionPlan } from "./model.ts";
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

export interface BrowserOracleEvidence {
  readonly commandCount: number;
  readonly effectCount: number;
  readonly semanticHash: string;
  readonly replayHash: string;
}

export interface ProductionT3BrowserDriver {
  readonly navigate: (url: string) => Promise<void>;
  readonly assertProductionSurface: (
    selectors: typeof PRODUCTION_BROWSER_SELECTORS_V1,
  ) => Promise<void>;
  readonly cachedContentNonblank: (selector: string) => Promise<boolean>;
  readonly submitComposer: (input: {
    readonly composerSelector: string;
    readonly submitSelector: string;
    readonly durableIntentSelector: string;
    readonly text: string;
  }) => Promise<number>;
  readonly waitForConnectionStatus: (selector: string, timeoutMs: number) => Promise<number>;
  readonly waitForRecovery: (selector: string, timeoutMs: number) => Promise<number>;
  readonly reload: () => Promise<void>;
  readonly applyControl: (
    control: NetworkFaultControl,
    decisionToken: string,
  ) => Promise<{ readonly decisionToken: string; readonly effectiveControl: NetworkFaultControl }>;
  readonly traffic: () => BrowserTrafficMetrics;
  readonly close: () => Promise<{ readonly complete: boolean; readonly details: string }>;
}

export interface ProductionT3BrowserFixture {
  readonly prepare: (
    plan: ScenarioExecutionPlan,
    variant: "baseline" | "candidate",
  ) => Promise<{
    readonly appUrl: string;
    readonly driver: ProductionT3BrowserDriver;
    readonly collectOracle: () => Promise<BrowserOracleEvidence>;
    readonly faultEvidenceComplete: () => Promise<boolean>;
    readonly cleanup: () => Promise<{ readonly complete: boolean; readonly details: string }>;
  }>;
}

export interface BrowserScenarioRunOptions {
  readonly statusTimeoutMs?: number;
  readonly recoveryTimeoutMs?: number;
}

const SUBMIT_SELECTOR = 'button[aria-label="Send message"],button[aria-label="Queue message"]';

export async function runProductionT3BrowserScenario(
  plan: ScenarioExecutionPlan,
  variant: "baseline" | "candidate",
  fixture: ProductionT3BrowserFixture,
  options: BrowserScenarioRunOptions = {},
): Promise<BrowserNetworkLabMeasurement> {
  const prepared = await fixture.prepare(plan, variant);
  const localAcceptanceMs: Array<number> = [];
  const statusVisibilityMs: Array<number> = [];
  const faultSequence: Array<string> = [];
  let cachedContentNonblank = false;
  let connectionStatusVisible = false;
  let recoveryLatencyMs = 0;
  let faultEvidenceComplete = false;
  let browserCleanupComplete = false;
  let fixtureCleanupComplete = false;
  let oracle: BrowserOracleEvidence | undefined;
  let traffic: BrowserTrafficMetrics = {
    bytesSent: 0,
    bytesReceived: 0,
    requestCount: 0,
    eventCount: 0,
  };

  try {
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
        faultSequence.push(`${observed.decisionToken}:${observed.effectiveControl.kind}`);
        if (step.control.lifecycle === "apply") {
          const statusMs = await prepared.driver.waitForConnectionStatus(
            PRODUCTION_BROWSER_SELECTORS_V1.connectionStatus,
            options.statusTimeoutMs ?? 5_000,
          );
          statusVisibilityMs.push(statusMs);
          connectionStatusVisible = true;
        } else {
          recoveryLatencyMs = await prepared.driver.waitForRecovery(
            PRODUCTION_BROWSER_SELECTORS_V1.connectionStatus,
            options.recoveryTimeoutMs ?? 30_000,
          );
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
        localAcceptanceMs.push(
          await prepared.driver.submitComposer({
            composerSelector: PRODUCTION_BROWSER_SELECTORS_V1.composer,
            submitSelector: SUBMIT_SELECTOR,
            durableIntentSelector: PRODUCTION_BROWSER_SELECTORS_V1.durableIntent,
            text,
          }),
        );
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
    oracle = await prepared.collectOracle();
    faultEvidenceComplete = await prepared.faultEvidenceComplete();
    traffic = prepared.driver.traffic();
  } finally {
    const [browserCleanup, fixtureCleanup] = await Promise.allSettled([
      prepared.driver.close(),
      prepared.cleanup(),
    ]);
    browserCleanupComplete = browserCleanup.status === "fulfilled" && browserCleanup.value.complete;
    fixtureCleanupComplete = fixtureCleanup.status === "fulfilled" && fixtureCleanup.value.complete;
  }

  if (!oracle) throw new Error("Browser oracle evidence was unavailable.");
  return {
    schemaVersion: 1,
    identity: plan.identity,
    variant,
    localAcceptanceMs,
    statusVisibilityMs,
    recoveryLatencyMs,
    ...oracle,
    cachedContentNonblank,
    connectionStatusVisible,
    faultSequence,
    traffic,
    faultEvidenceComplete,
    cleanupEvidenceComplete: browserCleanupComplete && fixtureCleanupComplete,
  };
}

export async function runProductionT3BrowserComparisonGate(input: {
  readonly plan: ScenarioExecutionPlan;
  readonly baselineFixture: ProductionT3BrowserFixture;
  readonly candidateFixture: ProductionT3BrowserFixture;
  readonly thresholds?: BrowserNetworkLabThresholds;
  readonly options?: BrowserScenarioRunOptions;
}): Promise<BrowserNetworkLabComparison> {
  const baseline = await runProductionT3BrowserScenario(
    input.plan,
    "baseline",
    input.baselineFixture,
    input.options,
  );
  const candidate = await runProductionT3BrowserScenario(
    input.plan,
    "candidate",
    input.candidateFixture,
    input.options,
  );
  const repeatedCandidate = await runProductionT3BrowserScenario(
    input.plan,
    "candidate",
    input.candidateFixture,
    input.options,
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
