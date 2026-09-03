import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  NetworkLabScenario,
  NetworkProfile,
  type ResourceLease,
  type ScenarioExecutionPlan,
} from "./model.ts";
import {
  type CorrectnessEvidence,
  type FaultEvidence,
  type FaultOperationEvidence,
  NetworkLabResult,
  type ObservationEvidence,
} from "./result.ts";
import { runNetworkLabScenario, type NetworkLabAdapter } from "./runner.ts";
import { makeScenarioExecutionPlan } from "./scenario.ts";

const decodeScenario = Schema.decodeUnknownSync(NetworkLabScenario);
const decodeProfile = Schema.decodeUnknownSync(NetworkProfile);
const decodeResult = Schema.decodeUnknownSync(NetworkLabResult);

const provenance = {
  lab: { id: "network-lab", version: 1 },
  adapter: { id: "test-adapter", version: 1 },
} as const;
const scenario = decodeScenario({
  schemaVersion: 1,
  identity: { id: "direct.checkpoint-driven", version: 1 },
  topology: "direct",
  steps: [
    { kind: "checkpoint", id: "ready", checkpoint: "client.connected", timeoutMs: 5_000 },
    {
      kind: "control",
      id: "blackhole-on",
      control: {
        schemaVersion: 1,
        kind: "data-plane-blackhole",
        surface: "client-path",
        direction: "origin-to-client",
        lifecycle: "apply",
        semantics: "drop-all-matching-data-plane-packets-v1",
      },
    },
    { kind: "action", id: "dispatch", action: "client.command.dispatch", parameters: {} },
    {
      kind: "control",
      id: "blackhole-off",
      control: {
        schemaVersion: 1,
        kind: "data-plane-blackhole",
        surface: "client-path",
        direction: "origin-to-client",
        lifecycle: "remove",
        semantics: "drop-all-matching-data-plane-packets-v1",
      },
    },
  ],
});
const profile = decodeProfile({
  schemaVersion: 1,
  identity: { id: "clean", version: 1 },
  clientPath: { latencyMs: 0, jitterMs: 0, lossPercent: 0, bandwidthKbps: null },
  semantics: {
    latency: "constant-one-way-delay-ms-v1",
    jitter: "uniform-plus-or-minus-delay-ms-clamped-at-zero-v1",
    loss: "independent-per-packet-percent-v1",
    bandwidth: {
      limited: "maximum-throughput-kilobits-per-second-v1",
      unlimited: "null-means-unlimited-no-rate-limit-v1",
    },
  },
  originPath: "unshaped",
});
const plan = makeScenarioExecutionPlan(scenario, profile, 17, provenance);
const lease: ResourceLease = {
  id: "lease-17",
  resources: [
    { kind: "namespace", id: "lab-17" },
    { kind: "temporary-directory", id: "artifacts-17" },
  ],
};

function observation(key: string, sequence: number): ObservationEvidence {
  return { key, sequence, details: {} };
}

function matchingFaultEvidence(context: ScenarioExecutionPlan): FaultEvidence {
  const operations: Array<FaultOperationEvidence> = [];
  for (const plannedStep of context.steps) {
    if (plannedStep.step.kind !== "control") continue;
    operations.push({
      stepId: plannedStep.step.id,
      sequence: plannedStep.sequence,
      decisionToken: plannedStep.decisionToken,
      effectiveControl: plannedStep.step.control,
      details: {},
    });
  }
  return {
    status: "passed",
    originPathUnshaped: true,
    operations,
  };
}

function makeAdapter(
  calls: Array<string>,
  overrides: Partial<NetworkLabAdapter> = {},
): NetworkLabAdapter {
  return {
    provenance,
    prepare: async () => {
      calls.push("prepare");
      return lease;
    },
    executeAction: async (step, plannedStep) => {
      calls.push(`action:${step.action}`);
      return observation(step.action, plannedStep.sequence);
    },
    executeControl: async (step, plannedStep) => {
      calls.push(`control:${step.control.kind}:${step.control.lifecycle}`);
      return observation(step.control.kind, plannedStep.sequence);
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
    collectFaultEvidence: async (context) => {
      calls.push("fault");
      return matchingFaultEvidence(context);
    },
    cleanupResource: async (resource) => {
      calls.push(`cleanup:${resource.id}`);
      return { ...resource, released: true, details: {}, error: null };
    },
    ...overrides,
  };
}

describe("network-lab runner", () => {
  it("executes application, control, and checkpoint steps in deterministic order", async () => {
    const calls: Array<string> = [];
    const result = await runNetworkLabScenario(plan, makeAdapter(calls));

    assert.equal(result.status, "passed");
    assert.deepStrictEqual(calls, [
      "prepare",
      "checkpoint:client.connected",
      "control:data-plane-blackhole:apply",
      "action:client.command.dispatch",
      "control:data-plane-blackhole:remove",
      "correctness",
      "fault",
      "cleanup:lab-17",
      "cleanup:artifacts-17",
    ]);
    assert.deepStrictEqual(
      result.steps.map(({ kind }) => kind),
      ["checkpoint", "control", "action", "control"],
    );
    assert.doesNotThrow(() => decodeResult(result));
  });

  it("cannot pass a forged compiled plan with no control steps", async () => {
    const zeroControlPlan: ScenarioExecutionPlan = {
      ...plan,
      steps: plan.steps.filter((plannedStep) => plannedStep.step.kind === "action"),
    };
    const result = await runNetworkLabScenario(
      zeroControlPlan,
      makeAdapter([], {
        collectFaultEvidence: async () =>
          ({
            status: "passed",
            originPathUnshaped: true,
            operations: [],
          }) as unknown as FaultEvidence,
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(result.evidence.fault.status, "failed");
  });

  it("rejects forged passing results at the public schema boundary", async () => {
    const valid = await runNetworkLabScenario(plan, makeAdapter([]));
    assert.equal(valid.status, "passed");

    const forged = [
      {
        ...valid,
        evidence: {
          ...valid.evidence,
          correctness: { status: "passed", assertions: [] },
        },
      },
      {
        ...valid,
        evidence: {
          ...valid.evidence,
          correctness: {
            status: "passed",
            assertions: [{ id: "false", passed: false, expected: 1, observed: 2 }],
          },
        },
      },
      {
        ...valid,
        evidence: { ...valid.evidence, fault: { ...valid.evidence.fault, operations: [] } },
      },
      {
        ...valid,
        evidence: { ...valid.evidence, cleanup: { ...valid.evidence.cleanup, leaseId: null } },
      },
      {
        ...valid,
        evidence: { ...valid.evidence, cleanup: { ...valid.evidence.cleanup, resources: [] } },
      },
      {
        ...valid,
        evidence: {
          ...valid.evidence,
          cleanup: {
            ...valid.evidence.cleanup,
            resources: [
              { ...valid.evidence.cleanup.resources[0]!, released: false, error: "still present" },
            ],
          },
        },
      },
      {
        ...valid,
        evidence: {
          ...valid.evidence,
          fault: { status: "failed", originPathUnshaped: true, operations: [] },
        },
      },
      {
        ...valid,
        errors: [
          {
            phase: "fault-evidence",
            stepId: null,
            resourceId: null,
            name: "ForgedError",
            message: "A passed result cannot contain errors.",
          },
        ],
      },
    ];

    for (const value of forged) {
      assert.throws(() => decodeResult(value));
    }
  });

  it("rejects empty or duplicate named correctness assertions", async () => {
    for (const assertions of [
      [],
      [
        { id: "same", passed: true, expected: 1, observed: 1 },
        { id: "same", passed: true, expected: 1, observed: 1 },
      ],
    ]) {
      const result = await runNetworkLabScenario(
        plan,
        makeAdapter([], {
          collectCorrectnessEvidence: async () =>
            ({ status: "passed", assertions }) as unknown as CorrectnessEvidence,
        }),
      );
      assert.equal(result.status, "failed");
      assert.equal(result.evidence.correctness.status, "failed");
    }
  });

  it("rejects empty, duplicate, reordered, wrong-kind, and mismatched fault evidence", async () => {
    const matching = matchingFaultEvidence(plan);
    const wrongKind = {
      ...matching.operations[0]!,
      effectiveControl: {
        schemaVersion: 1 as const,
        kind: "data-plane-reset" as const,
        surface: "client-path" as const,
        direction: "origin-to-client" as const,
        lifecycle: "apply" as const,
        semantics: "terminate-active-matching-connections-v1" as const,
      },
    };
    const variants = [
      { ...matching, operations: [] },
      { ...matching, operations: [matching.operations[0]!, matching.operations[0]!] },
      { ...matching, operations: matching.operations.toReversed() },
      { ...matching, operations: [wrongKind, matching.operations[1]!] },
      {
        ...matching,
        operations: [{ ...matching.operations[0]!, sequence: 99 }, matching.operations[1]!],
      },
    ];

    for (const evidence of variants) {
      const result = await runNetworkLabScenario(
        plan,
        makeAdapter([], {
          collectFaultEvidence: async () => evidence as unknown as FaultEvidence,
        }),
      );
      assert.equal(result.status, "failed");
      assert.equal(result.evidence.fault.status, "failed");
    }
  });

  it("aborts a hung collector at its deadline and still cleans the lease", async () => {
    const calls: Array<string> = [];
    let collectorAborted = false;
    const adapter = makeAdapter(calls, {
      collectCorrectnessEvidence: async (_context, { signal }) =>
        await new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              collectorAborted = true;
              resolve({ status: "unavailable", assertions: [] });
            },
            { once: true },
          );
        }),
    });

    const result = await runNetworkLabScenario(plan, adapter, { timeouts: { evidenceMs: 5 } });

    assert.equal(result.status, "failed");
    assert.equal(collectorAborted, true);
    assert.deepStrictEqual(
      calls.filter((call) => call.startsWith("cleanup:")),
      ["cleanup:lab-17", "cleanup:artifacts-17"],
    );
    assert.equal(result.errors[0]?.name, "AdapterOperationTimeoutError");
  });

  it("preserves per-resource proof and continues after a partial cleanup failure", async () => {
    const calls: Array<string> = [];
    const result = await runNetworkLabScenario(
      plan,
      makeAdapter(calls, {
        cleanupResource: async (resource) => {
          calls.push(`cleanup:${resource.id}`);
          if (resource.id === "lab-17") throw new Error("namespace busy");
          return { ...resource, released: true, details: { removed: true }, error: null };
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.equal(result.evidence.cleanup.status, "failed");
    assert.deepStrictEqual(
      result.evidence.cleanup.resources.map(({ id, released }) => ({ id, released })),
      [
        { id: "lab-17", released: false },
        { id: "artifacts-17", released: true },
      ],
    );
    assert.equal(result.errors.at(-1)?.resourceId, "lab-17");
  });

  it("rejects missing cleanup registration and adapter provenance drift", async () => {
    const noResources = await runNetworkLabScenario(
      plan,
      makeAdapter([], {
        prepare: async () => ({ id: "empty", resources: [] }) as unknown as ResourceLease,
      }),
    );
    assert.equal(noResources.status, "failed");
    assert.deepStrictEqual(noResources.evidence.cleanup.resources, []);

    const wrongProvenance = await runNetworkLabScenario(
      plan,
      makeAdapter([], { provenance: { ...provenance, adapter: { id: "wrong", version: 1 } } }),
    );
    assert.equal(wrongProvenance.status, "failed");
    assert.equal(wrongProvenance.errors[0]?.phase, "prepare");
  });
});
