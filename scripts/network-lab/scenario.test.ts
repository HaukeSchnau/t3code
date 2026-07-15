import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { NetworkLabScenario, NetworkProfile } from "./model.ts";
import { makeScenarioExecutionPlan, NetworkLabScenarioError } from "./scenario.ts";

const decodeScenario = Schema.decodeUnknownSync(NetworkLabScenario);
const decodeProfile = Schema.decodeUnknownSync(NetworkProfile);

const scenario = decodeScenario({
  schemaVersion: 1,
  identity: { id: "direct.ack-loss-recovery", version: 1 },
  topology: "direct",
  steps: [
    {
      kind: "checkpoint",
      id: "connected",
      checkpoint: "client.connected",
      timeoutMs: 5_000,
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
  clientPath: {
    latencyMs: 250,
    jitterMs: 25,
    lossPercent: 2,
    bandwidthKbps: 1_000,
  },
  originPath: "unshaped",
});

describe("network-lab scenario model", () => {
  it("creates a stable identity and fault decision sequence for the same seed", () => {
    const first = makeScenarioExecutionPlan(scenario, profile, 104_729);
    const second = makeScenarioExecutionPlan(scenario, profile, 104_729);

    assert.deepStrictEqual(first, second);
    assert.equal(first.identity.scenario.id, "direct.ack-loss-recovery");
    assert.equal(first.identity.profile.id, "poor-250ms-2pct-1mbit");
    assert.equal(first.identity.seed, 104_729);
    assert.match(
      first.identity.executionId,
      /^direct\.ack-loss-recovery@1\/poor-250ms-2pct-1mbit@1\/seed-104729\/[0-9a-f]{16}$/,
    );
  });

  it("changes only seeded decisions when the seed changes", () => {
    const first = makeScenarioExecutionPlan(scenario, profile, 1);
    const second = makeScenarioExecutionPlan(scenario, profile, 2);

    assert.equal(first.identity.definitionHash, second.identity.definitionHash);
    assert.notEqual(
      first.steps.map((step) => step.decisionToken).join(","),
      second.steps.map((step) => step.decisionToken).join(","),
    );
  });

  it("rejects sleep steps and shaped origin links at the schema boundary", () => {
    assert.throws(() =>
      decodeScenario({
        ...scenario,
        steps: [{ kind: "sleep", id: "wait", durationMs: 100 }],
      }),
    );
    assert.throws(() =>
      decodeProfile({
        ...profile,
        originPath: { latencyMs: 250 },
      }),
    );
  });

  it("rejects duplicate step ids before allocating adapter resources", () => {
    let caught: unknown;
    try {
      makeScenarioExecutionPlan(
        {
          ...scenario,
          steps: [scenario.steps[0]!, { ...scenario.steps[1]!, id: "connected" }],
        },
        profile,
        1,
      );
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof NetworkLabScenarioError);
    assert.equal(caught.reason, "duplicate-step-id");
  });
});
