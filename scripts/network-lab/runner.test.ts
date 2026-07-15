import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { NetworkLabScenario, NetworkProfile } from "./model.ts";
import { NetworkLabResult, type ObservationEvidence } from "./result.ts";
import { runNetworkLabScenario, type NetworkLabAdapter } from "./runner.ts";
import { makeScenarioExecutionPlan } from "./scenario.ts";

const decodeScenario = Schema.decodeUnknownSync(NetworkLabScenario);
const decodeProfile = Schema.decodeUnknownSync(NetworkProfile);
const decodeResult = Schema.decodeUnknownSync(NetworkLabResult);

const scenario = decodeScenario({
  schemaVersion: 1,
  identity: { id: "direct.checkpoint-driven", version: 1 },
  topology: "direct",
  steps: [
    {
      kind: "checkpoint",
      id: "ready",
      checkpoint: "client.connected",
      timeoutMs: 5_000,
    },
    {
      kind: "action",
      id: "blackhole",
      action: "fault.link.blackhole",
      parameters: {},
    },
  ],
});
const profile = decodeProfile({
  schemaVersion: 1,
  identity: { id: "clean", version: 1 },
  clientPath: { latencyMs: 0, jitterMs: 0, lossPercent: 0, bandwidthKbps: null },
  originPath: "unshaped",
});
const plan = makeScenarioExecutionPlan(scenario, profile, 17);

function observation(key: string, sequence: number): ObservationEvidence {
  return { key, sequence, details: {} };
}

function makeAdapter(
  calls: Array<string>,
  overrides: Partial<NetworkLabAdapter> = {},
): NetworkLabAdapter {
  return {
    prepare: async () => {
      calls.push("prepare");
    },
    executeAction: async (step, plannedStep) => {
      calls.push(`action:${step.action}`);
      return observation(step.action, plannedStep.sequence);
    },
    waitForCheckpoint: async (step, plannedStep) => {
      calls.push(`checkpoint:${step.checkpoint}`);
      return observation(step.checkpoint, plannedStep.sequence);
    },
    collectCorrectnessEvidence: async () => {
      calls.push("correctness");
      return {
        status: "passed",
        assertions: [{ id: "one-effect", passed: true, expected: 1, observed: 1 }],
      };
    },
    collectFaultEvidence: async () => {
      calls.push("fault");
      return {
        status: "passed",
        originPathUnshaped: true,
        events: [observation("fault.link.blackhole", 1)],
      };
    },
    cleanup: async () => {
      calls.push("cleanup");
      return {
        status: "passed",
        resources: [{ kind: "temporary-directory", id: "lab-17", released: true, details: {} }],
      };
    },
    ...overrides,
  };
}

describe("network-lab runner", () => {
  it("executes checkpoint observations and actions in deterministic plan order", async () => {
    const calls: Array<string> = [];
    const result = await runNetworkLabScenario(plan, makeAdapter(calls));

    assert.equal(result.status, "passed");
    assert.deepStrictEqual(calls, [
      "prepare",
      "checkpoint:client.connected",
      "action:fault.link.blackhole",
      "correctness",
      "fault",
      "cleanup",
    ]);
    assert.deepStrictEqual(
      result.steps.map(({ id, kind, status }) => ({ id, kind, status })),
      [
        { id: "ready", kind: "checkpoint", status: "passed" },
        { id: "blackhole", kind: "action", status: "passed" },
      ],
    );
    assert.doesNotThrow(() => decodeResult(result));
  });

  it("still emits correctness, fault, and cleanup evidence after a step failure", async () => {
    const calls: Array<string> = [];
    const adapter = makeAdapter(calls, {
      waitForCheckpoint: async () => {
        calls.push("checkpoint:client.connected");
        throw new Error("checkpoint timed out");
      },
    });

    const result = await runNetworkLabScenario(plan, adapter);

    assert.equal(result.status, "failed");
    assert.equal(result.steps[0]?.status, "failed");
    assert.equal(result.evidence.correctness.status, "passed");
    assert.equal(result.evidence.fault.status, "passed");
    assert.equal(result.evidence.cleanup.status, "passed");
    assert.deepStrictEqual(calls, [
      "prepare",
      "checkpoint:client.connected",
      "correctness",
      "fault",
      "cleanup",
    ]);
    assert.deepStrictEqual(result.errors, [
      {
        phase: "step",
        stepId: "ready",
        name: "Error",
        message: "checkpoint timed out",
      },
    ]);
  });

  it("records unavailable evidence and cleanup failures without rejecting", async () => {
    const calls: Array<string> = [];
    const adapter = makeAdapter(calls, {
      prepare: async () => {
        calls.push("prepare");
        throw new Error("prepare failed");
      },
      collectCorrectnessEvidence: async () => {
        calls.push("correctness");
        throw new Error("correctness unavailable");
      },
      collectFaultEvidence: async () => {
        calls.push("fault");
        throw new Error("fault proof unavailable");
      },
      cleanup: async () => {
        calls.push("cleanup");
        throw new Error("cleanup failed");
      },
    });

    const result = await runNetworkLabScenario(plan, adapter);

    assert.equal(result.status, "failed");
    assert.deepStrictEqual(result.steps, []);
    assert.equal(result.evidence.correctness.status, "unavailable");
    assert.equal(result.evidence.fault.status, "unavailable");
    assert.equal(result.evidence.cleanup.status, "failed");
    assert.deepStrictEqual(
      result.errors.map(({ phase }) => phase),
      ["prepare", "correctness-evidence", "fault-evidence", "cleanup"],
    );
    assert.doesNotThrow(() => decodeResult(result));
  });

  it("does not trust passing summaries that contradict their detailed evidence", async () => {
    const calls: Array<string> = [];
    const adapter = makeAdapter(calls, {
      collectCorrectnessEvidence: async () => ({
        status: "passed",
        assertions: [{ id: "one-effect", passed: false, expected: 1, observed: 2 }],
      }),
      collectFaultEvidence: async () => ({
        status: "passed",
        originPathUnshaped: false,
        events: [],
      }),
      cleanup: async () => ({
        status: "passed",
        resources: [{ kind: "namespace", id: "lab-17", released: false, details: {} }],
      }),
    });

    const result = await runNetworkLabScenario(plan, adapter);

    assert.equal(result.status, "failed");
    assert.equal(result.evidence.correctness.status, "failed");
    assert.equal(result.evidence.fault.status, "failed");
    assert.equal(result.evidence.cleanup.status, "failed");
  });
});
