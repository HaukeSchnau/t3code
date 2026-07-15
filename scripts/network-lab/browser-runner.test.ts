import * as NodeAssert from "node:assert/strict";

import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { NetworkLabScenario, NetworkProfile } from "./model.ts";
import { CI_BROWSER_NETWORK_LAB_THRESHOLDS_V1 } from "./comparator.ts";
import {
  runProductionT3BrowserComparisonGate,
  runProductionT3BrowserScenario,
  type BrowserFaultEvidence,
  type ProductionT3BrowserDriver,
  type ProductionT3BrowserFixture,
} from "./browser-runner.ts";
import { makeScenarioExecutionPlan } from "./scenario.ts";

const decodeScenario = Schema.decodeUnknownSync(NetworkLabScenario);
const decodeProfile = Schema.decodeUnknownSync(NetworkProfile);
const semantics = {
  latency: "constant-one-way-delay-ms-v1",
  jitter: "uniform-plus-or-minus-delay-ms-clamped-at-zero-v1",
  loss: "independent-per-packet-percent-v1",
  bandwidth: {
    limited: "maximum-throughput-kilobits-per-second-v1",
    unlimited: "null-means-unlimited-no-rate-limit-v1",
  },
} as const;
const scenario = decodeScenario({
  schemaVersion: 1,
  identity: { id: "direct.browser-poor", version: 1 },
  topology: "direct",
  steps: [
    {
      kind: "control",
      id: "poor-on",
      control: {
        schemaVersion: 1,
        kind: "directional-impairment",
        surface: "client-path",
        direction: "bidirectional",
        lifecycle: "apply",
        parameters: { latencyMs: 250, jitterMs: 25, lossPercent: 2, bandwidthKbps: 1_000 },
        semantics,
      },
    },
    {
      kind: "checkpoint",
      id: "status-visible",
      checkpoint: "browser.connection-status-visible",
      timeoutMs: 5_000,
    },
    {
      kind: "action",
      id: "submit",
      action: "browser.composer.submit",
      parameters: { text: "persist this intent" },
    },
    {
      kind: "action",
      id: "reload",
      action: "browser.reload",
      parameters: {},
    },
    {
      kind: "control",
      id: "poor-off",
      control: {
        schemaVersion: 1,
        kind: "directional-impairment",
        surface: "client-path",
        direction: "bidirectional",
        lifecycle: "remove",
        parameters: { latencyMs: 250, jitterMs: 25, lossPercent: 2, bandwidthKbps: 1_000 },
        semantics,
      },
    },
    {
      kind: "checkpoint",
      id: "recovered",
      checkpoint: "browser.recovered",
      timeoutMs: 30_000,
    },
  ],
});
const profile = decodeProfile({
  schemaVersion: 1,
  identity: { id: "poor", version: 1 },
  clientPath: { latencyMs: 250, jitterMs: 25, lossPercent: 2, bandwidthKbps: 1_000 },
  semantics,
  originPath: "unshaped",
});
const plan = makeScenarioExecutionPlan(scenario, profile, 17, {
  lab: { id: "network-lab", version: 1 },
  adapter: { id: "chromium", version: 1 },
});

function makeFixture(
  calls: Array<string>,
  options: { cleanup?: boolean; semanticHash?: string; acceptanceMs?: number } = {},
): ProductionT3BrowserFixture {
  let generation = 0;
  return {
    prepare: async (preparedPlan, variant) => {
      generation += 1;
      const faultEvidence: Array<BrowserFaultEvidence> = [];
      const driver: ProductionT3BrowserDriver = {
        navigate: async (url) => void calls.push(`navigate:${variant}:${url}`),
        assertProductionSurface: async () => void calls.push("surface"),
        cachedContentNonblank: async () => (calls.push("cached"), true),
        submitComposer: async ({ text }) => {
          calls.push(`submit:${text}`);
          return {
            localAcceptanceMs: options.acceptanceMs ?? 40,
            commandId: `command-${generation}`,
            text,
          };
        },
        waitForConnectionStatus: async () => (calls.push("status"), 50),
        waitForRecovery: async () => (calls.push("recovered"), 1_000),
        reload: async () => void calls.push("reload"),
        applyControl: async (control, decisionToken) => {
          calls.push(`control:${control.kind}:${control.lifecycle}`);
          faultEvidence.push({
            decisionToken,
            effectiveControl: control,
            mechanism:
              control.kind === "protocol-suppression"
                ? "external-protocol-suppression-adapter"
                : "chromium-cdp",
          });
          return { decisionToken, effectiveControl: control };
        },
        traffic: () => ({
          bytesSent: 1_000,
          bytesReceived: 2_000,
          requestCount: 5,
          eventCount: 7,
        }),
        close: async () => ({ complete: options.cleanup ?? true, details: "browser" }),
      };
      return {
        appUrl: "http://127.0.0.1:5733/thread/fixture",
        driver,
        collectOracle: async () => ({
          commandCount: 1,
          effectCount: 1,
          semanticHash: options.semanticHash ?? "semantic",
          replayHash: "replay",
        }),
        faultEvidence: async () => faultEvidence,
        isolation: {
          id: `${variant}-${generation}`,
          executionId: preparedPlan.identity.executionId,
          variant,
          exclusive: true,
        },
        cleanup: async () => ({ complete: options.cleanup ?? true, details: "fixture" }),
      };
    },
    cleanupPreparationFailure: async () => ({ complete: true, details: "no resources acquired" }),
  };
}

describe("production T3 Chromium scenario runner", () => {
  it("drives composer, durable intent, reload, controls, oracle, and cleanup through one contract", async () => {
    const calls: Array<string> = [];
    const result = await runProductionT3BrowserScenario(plan, "candidate", makeFixture(calls));

    assert.equal(result.cleanupEvidenceComplete, true);
    assert.equal(result.cachedContentNonblank, true);
    assert.deepStrictEqual(result.localAcceptanceMs, [40]);
    assert.deepStrictEqual(result.statusVisibilityMs, [50]);
    assert.deepStrictEqual(
      calls.filter(
        (call) => call.startsWith("control:") || call.startsWith("submit:") || call === "reload",
      ),
      [
        "control:directional-impairment:apply",
        "submit:persist this intent",
        "reload",
        "control:directional-impairment:remove",
      ],
    );
  });

  it("runs baseline plus two identical candidate seeds and fails the command on regression", async () => {
    const passing = await runProductionT3BrowserComparisonGate({
      plan,
      baselineFixture: makeFixture([]),
      candidateFixture: makeFixture([]),
      thresholds: {
        ...CI_BROWSER_NETWORK_LAB_THRESHOLDS_V1,
        minimumAcceptanceSamples: 1,
        minimumStatusSamples: 1,
      },
    });
    assert.equal(passing.status, "passed");

    await NodeAssert.rejects(
      runProductionT3BrowserComparisonGate({
        plan,
        baselineFixture: makeFixture([]),
        candidateFixture: makeFixture([], { cleanup: false }),
        thresholds: {
          ...CI_BROWSER_NETWORK_LAB_THRESHOLDS_V1,
          minimumAcceptanceSamples: 1,
          minimumStatusSamples: 1,
        },
      }),
      /cleanup evidence was incomplete/,
    );
  });

  it("uses only explicit checkpoints for status and recovery measurements", async () => {
    const withoutCheckpoints = {
      ...plan,
      steps: plan.steps.filter(({ step }) => step.kind !== "checkpoint"),
    };
    await NodeAssert.rejects(
      runProductionT3BrowserScenario(withoutCheckpoints, "candidate", makeFixture([])),
      /requires DOM-visible connection status evidence/,
    );
    const withoutRecovery = {
      ...plan,
      steps: plan.steps.filter(
        ({ step }) => step.kind !== "checkpoint" || step.checkpoint !== "browser.recovered",
      ),
    };
    await NodeAssert.rejects(
      runProductionT3BrowserScenario(withoutRecovery, "candidate", makeFixture([])),
      /requires an observed browser.recovered checkpoint/,
    );
  });

  it("structurally rejects fault evidence that does not match the compiled plan", async () => {
    const base = makeFixture([]);
    const fixture: ProductionT3BrowserFixture = {
      ...base,
      prepare: async (...arguments_) => {
        const prepared = await base.prepare(...arguments_);
        return {
          ...prepared,
          faultEvidence: async () =>
            (await prepared.faultEvidence()).map((evidence, index) =>
              index === 0 ? { ...evidence, decisionToken: "forged-token" } : evidence,
            ),
        };
      },
    };
    await NodeAssert.rejects(
      runProductionT3BrowserScenario(plan, "candidate", fixture),
      /Fault evidence did not match planned control/,
    );
  });

  it("binds each fault kind to its permitted evidence mechanism", async () => {
    const base = makeFixture([]);
    const fixture: ProductionT3BrowserFixture = {
      ...base,
      prepare: async (...arguments_) => {
        const prepared = await base.prepare(...arguments_);
        return {
          ...prepared,
          faultEvidence: async () =>
            (await prepared.faultEvidence()).map((evidence) => ({
              ...evidence,
              mechanism: "external-protocol-suppression-adapter" as const,
            })),
        };
      },
    };
    await NodeAssert.rejects(
      runProductionT3BrowserScenario(plan, "candidate", fixture),
      /Fault evidence did not match planned control/,
    );

    const protocolPlan = {
      ...plan,
      steps: plan.steps.map((plannedStep, index) =>
        index === 0
          ? {
              ...plannedStep,
              step: {
                kind: "control" as const,
                id: "lost-ack-on",
                control: {
                  schemaVersion: 1 as const,
                  kind: "protocol-suppression" as const,
                  surface: "application-protocol" as const,
                  direction: "origin-to-client" as const,
                  lifecycle: "apply" as const,
                  protocol: "effect-rpc",
                  message: "acknowledgement" as const,
                  count: 1,
                  semantics: "suppress-next-matching-complete-protocol-message-v1" as const,
                },
              },
            }
          : plannedStep,
      ),
    };
    const protocolBase = makeFixture([]);
    const wrongProtocolFixture: ProductionT3BrowserFixture = {
      ...protocolBase,
      prepare: async (...arguments_) => {
        const prepared = await protocolBase.prepare(...arguments_);
        return {
          ...prepared,
          faultEvidence: async () =>
            (await prepared.faultEvidence()).map((evidence, index) =>
              index === 0 ? { ...evidence, mechanism: "chromium-cdp" as const } : evidence,
            ),
        };
      },
    };
    await NodeAssert.rejects(
      runProductionT3BrowserScenario(protocolPlan, "candidate", wrongProtocolFixture),
      /Fault evidence did not match planned control/,
    );
  });

  it("rolls back failed preparation and exposes incomplete rollback", async () => {
    let rollbackCalls = 0;
    const preparationError = new Error("prepare exploded");
    const fixture: ProductionT3BrowserFixture = {
      prepare: async () => Promise.reject(preparationError),
      cleanupPreparationFailure: async () => {
        rollbackCalls += 1;
        return { complete: false, details: "profile directory remains" };
      },
    };
    await NodeAssert.rejects(
      runProductionT3BrowserScenario(plan, "candidate", fixture),
      /preparation failed and rollback was incomplete/i,
    );
    assert.equal(rollbackCalls, 1);
  });

  it("cleans an invalid isolation lease before rejecting it", async () => {
    const calls: Array<string> = [];
    const base = makeFixture(calls);
    const fixture: ProductionT3BrowserFixture = {
      ...base,
      prepare: async (...arguments_) => {
        const prepared = await base.prepare(...arguments_);
        return {
          ...prepared,
          isolation: { ...prepared.isolation, executionId: "wrong-execution" },
          cleanup: async () => {
            calls.push("fixture-cleanup");
            return prepared.cleanup();
          },
        };
      },
    };
    await NodeAssert.rejects(
      runProductionT3BrowserScenario(plan, "candidate", fixture),
      /matching exclusive isolation metadata/,
    );
    assert.ok(calls.includes("fixture-cleanup"));
  });
});
