import * as NodeAssert from "node:assert/strict";

import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { NetworkLabScenario, NetworkProfile } from "./model.ts";
import {
  runProductionT3BrowserComparisonGate,
  runProductionT3BrowserScenario,
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
  return {
    prepare: async (_plan, variant) => {
      const driver: ProductionT3BrowserDriver = {
        navigate: async (url) => void calls.push(`navigate:${variant}:${url}`),
        assertProductionSurface: async () => void calls.push("surface"),
        cachedContentNonblank: async () => (calls.push("cached"), true),
        submitComposer: async ({ text }) => (
          calls.push(`submit:${text}`),
          options.acceptanceMs ?? 40
        ),
        waitForConnectionStatus: async () => (calls.push("status"), 50),
        waitForRecovery: async () => (calls.push("recovered"), 1_000),
        reload: async () => void calls.push("reload"),
        applyControl: async (control, decisionToken) => {
          calls.push(`control:${control.kind}:${control.lifecycle}`);
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
        faultEvidenceComplete: async () => true,
        cleanup: async () => ({ complete: options.cleanup ?? true, details: "fixture" }),
      };
    },
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
    });
    assert.equal(passing.status, "passed");

    await NodeAssert.rejects(
      runProductionT3BrowserComparisonGate({
        plan,
        baselineFixture: makeFixture([]),
        candidateFixture: makeFixture([], { cleanup: false }),
      }),
      /cleanup-evidence/,
    );
  });
});
