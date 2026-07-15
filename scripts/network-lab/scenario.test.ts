import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { NetworkLabScenario, NetworkProfile } from "./model.ts";
import { canonicalJson, makeScenarioExecutionPlan, NetworkLabScenarioError } from "./scenario.ts";

const decodeScenario = Schema.decodeUnknownSync(NetworkLabScenario);
const decodeProfile = Schema.decodeUnknownSync(NetworkProfile);

const impairmentSemantics = {
  latency: "constant-one-way-delay-ms-v1",
  jitter: "uniform-plus-or-minus-delay-ms-v1",
  loss: "independent-per-packet-percent-v1",
  bandwidth: "maximum-throughput-kilobits-per-second-v1",
} as const;

const scenario = decodeScenario({
  schemaVersion: 1,
  identity: { id: "direct.ack-loss-recovery", version: 1 },
  topology: "direct",
  steps: [
    { kind: "checkpoint", id: "connected", checkpoint: "client.connected", timeoutMs: 5_000 },
    {
      kind: "control",
      id: "degrade-downlink",
      control: {
        schemaVersion: 1,
        kind: "directional-impairment",
        surface: "client-path",
        direction: "origin-to-client",
        lifecycle: "apply",
        parameters: { latencyMs: 250, jitterMs: 25, lossPercent: 2, bandwidthKbps: 1_000 },
        semantics: impairmentSemantics,
      },
    },
    {
      kind: "action",
      id: "dispatch",
      action: "client.command.dispatch",
      parameters: { commandId: "cmd-recovery-1" },
    },
  ],
});

const profile = decodeProfile({
  schemaVersion: 1,
  identity: { id: "poor-250ms-2pct-1mbit", version: 1 },
  clientPath: { latencyMs: 250, jitterMs: 25, lossPercent: 2, bandwidthKbps: 1_000 },
  originPath: "unshaped",
});

const provenance = {
  lab: { id: "network-lab", version: 1 },
  adapter: { id: "test-adapter", version: 1 },
} as const;

describe("network-lab scenario model", () => {
  it("creates a stable golden identity and decision sequence", () => {
    const first = makeScenarioExecutionPlan(scenario, profile, 104_729, provenance);
    const second = makeScenarioExecutionPlan(scenario, profile, 104_729, provenance);

    assert.deepStrictEqual(first, second);
    assert.equal(first.identity.scenario.id, "direct.ack-loss-recovery");
    assert.equal(first.identity.profile.id, "poor-250ms-2pct-1mbit");
    assert.equal(first.identity.seed, 104_729);
    assert.equal(first.identity.definitionHash, "b6f6c633828b2f29");
    assert.deepStrictEqual(
      first.steps.map(({ decisionToken }) => decisionToken),
      ["5776b188", "a9b9d44b", "f52f47b3"],
    );
  });

  it("canonicalizes object keys by code unit without locale collation", () => {
    assert.equal(
      canonicalJson({ z: 1, ä: { b: 2, A: 1 }, a: 0 }),
      '{"a":0,"z":1,"ä":{"A":1,"b":2}}',
    );
  });

  it("hashes adapter and lab provenance alongside explicit impairment semantics", () => {
    const baseline = makeScenarioExecutionPlan(scenario, profile, 1, provenance);
    const changedAdapter = makeScenarioExecutionPlan(scenario, profile, 1, {
      ...provenance,
      adapter: { id: "other-adapter", version: 1 },
    });
    const changedLab = makeScenarioExecutionPlan(scenario, profile, 1, {
      ...provenance,
      lab: { id: "network-lab", version: 2 },
    });

    assert.notEqual(baseline.identity.definitionHash, changedAdapter.identity.definitionHash);
    assert.notEqual(baseline.identity.definitionHash, changedLab.identity.definitionHash);
  });

  it("changes only seeded decisions when the seed changes", () => {
    const first = makeScenarioExecutionPlan(scenario, profile, 1, provenance);
    const second = makeScenarioExecutionPlan(scenario, profile, 2, provenance);

    assert.equal(first.identity.definitionHash, second.identity.definitionHash);
    assert.notEqual(
      first.steps.map((step) => step.decisionToken).join(","),
      second.steps.map((step) => step.decisionToken).join(","),
    );
  });

  it("rejects opaque fault actions, invalid reset removal, and shaped origin links", () => {
    assert.throws(() =>
      decodeScenario({
        ...scenario,
        steps: [{ kind: "action", id: "fault", action: "fault.link.blackhole", parameters: {} }],
      }),
    );
    assert.throws(() =>
      decodeScenario({
        ...scenario,
        steps: [
          {
            kind: "control",
            id: "reset",
            control: {
              schemaVersion: 1,
              kind: "data-plane-reset",
              surface: "client-path",
              direction: "bidirectional",
              lifecycle: "remove",
              semantics: "terminate-active-matching-connections-v1",
            },
          },
        ],
      }),
    );
    assert.throws(() => decodeProfile({ ...profile, originPath: { latencyMs: 250 } }));
  });

  it("rejects duplicate step ids before allocating adapter resources", () => {
    let caught: unknown;
    try {
      makeScenarioExecutionPlan(
        { ...scenario, steps: [scenario.steps[0]!, { ...scenario.steps[1]!, id: "connected" }] },
        profile,
        1,
        provenance,
      );
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof NetworkLabScenarioError);
    assert.equal(caught.reason, "duplicate-step-id");
  });
});
