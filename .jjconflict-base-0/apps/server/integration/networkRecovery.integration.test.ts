import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  NetworkLabScenario,
  NetworkProfile,
  type ScenarioExecutionPlan,
} from "../../../scripts/network-lab/model.ts";
import { runNetworkLabScenario } from "../../../scripts/network-lab/runner.ts";
import { canonicalJson, makeScenarioExecutionPlan } from "../../../scripts/network-lab/scenario.ts";
import {
  NETWORK_RECOVERY_PROTOCOL,
  NETWORK_RECOVERY_PROVENANCE,
  makeNetworkRecoveryAdapter,
} from "./NetworkRecoveryHarness.integration.ts";

const decodeScenario = Schema.decodeUnknownSync(NetworkLabScenario);
const decodeProfile = Schema.decodeUnknownSync(NetworkProfile);
const SEED = 104_729;

const semantics = {
  latency: "constant-one-way-delay-ms-v1",
  jitter: "uniform-plus-or-minus-delay-ms-clamped-at-zero-v1",
  loss: "independent-per-packet-percent-v1",
  bandwidth: {
    limited: "maximum-throughput-kilobits-per-second-v1",
    unlimited: "null-means-unlimited-no-rate-limit-v1",
  },
} as const;

const profile = decodeProfile({
  schemaVersion: 1,
  identity: { id: "direct-unshaped-origin", version: 1 },
  clientPath: {
    latencyMs: 0,
    jitterMs: 0,
    lossPercent: 0,
    bandwidthKbps: null,
  },
  semantics,
  originPath: "unshaped",
});

function protocolControl(lifecycle: "apply" | "remove") {
  return {
    schemaVersion: 1 as const,
    kind: "protocol-suppression" as const,
    surface: "application-protocol" as const,
    direction: "origin-to-client" as const,
    lifecycle,
    protocol: NETWORK_RECOVERY_PROTOCOL,
    message: "response" as const,
    count: 1,
    semantics: "suppress-next-matching-complete-protocol-message-v1" as const,
  };
}

const oracleScenario = decodeScenario({
  schemaVersion: 1,
  identity: { id: "direct.effect-rpc-no-fault-oracle", version: 1 },
  topology: "direct",
  steps: [
    {
      kind: "control",
      id: "ensure-suppression-removed",
      control: protocolControl("remove"),
    },
    {
      kind: "action",
      id: "dispatch",
      action: "client.command.dispatch",
      parameters: { commandId: "nl1-turn-start" },
    },
    {
      kind: "checkpoint",
      id: "quiesced",
      checkpoint: "provider.turn.quiesced",
      timeoutMs: 30_000,
    },
  ],
});

const recoveryScenario = decodeScenario({
  schemaVersion: 1,
  identity: { id: "direct.effect-rpc-ack-loss-recovery", version: 1 },
  topology: "direct",
  steps: [
    {
      kind: "control",
      id: "suppress-committed-exit",
      control: protocolControl("apply"),
    },
    {
      kind: "action",
      id: "dispatch",
      action: "client.command.dispatch",
      parameters: { commandId: "nl1-turn-start" },
    },
    {
      kind: "action",
      id: "retry",
      action: "client.command.retry",
      parameters: { commandId: "nl1-turn-start" },
    },
    {
      kind: "checkpoint",
      id: "quiesced",
      checkpoint: "provider.turn.quiesced",
      timeoutMs: 30_000,
    },
  ],
});

async function runPlan(
  plan: ScenarioExecutionPlan,
  options: Parameters<typeof makeNetworkRecoveryAdapter>[0] = {},
) {
  const adapter = makeNetworkRecoveryAdapter(options);
  const result = await runNetworkLabScenario(plan, adapter, {
    timeouts: {
      prepareMs: 30_000,
      actionMs: 10_000,
      controlMs: 5_000,
      evidenceMs: 10_000,
      cleanupResourceMs: 10_000,
    },
  });
  return { adapter, result, summary: adapter.readSummary() };
}

describe("direct network recovery", () => {
  it("recovers a committed lost Exit exactly once and reproduces seeded controls", async () => {
    const oraclePlan = makeScenarioExecutionPlan(
      oracleScenario,
      profile,
      SEED,
      NETWORK_RECOVERY_PROVENANCE,
    );
    const recoveryPlan = makeScenarioExecutionPlan(
      recoveryScenario,
      profile,
      SEED,
      NETWORK_RECOVERY_PROVENANCE,
    );

    const oracle = await runPlan(oraclePlan);
    assert.equal(oracle.result.status, "passed", canonicalJson(oracle.result as never));
    assert.isNotNull(oracle.summary);
    const first = await runPlan(recoveryPlan);
    assert.equal(first.result.status, "passed");
    assert.isNotNull(first.summary);
    const repeated = await runPlan(recoveryPlan);

    assert.equal(repeated.result.status, "passed");
    assert.isNotNull(repeated.summary);

    assert.deepEqual(first.summary!.semanticProjection, oracle.summary!.semanticProjection);
    assert.equal(first.summary!.semanticHash, oracle.summary!.semanticHash);
    assert.equal(first.summary!.providerSendCount, 1);
    assert.equal(first.summary!.providerTurnCount, 1);
    assert.deepEqual(first.summary!.commandEventTypes, [
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    assert.equal(first.summary!.capturedRequests.length, 2);
    assert.deepEqual(
      first.summary!.capturedRequests.map(({ session, commandId, envelopeHash }) => ({
        session,
        commandId,
        envelopeHash,
      })),
      [
        {
          session: 1,
          commandId: "nl1-turn-start",
          envelopeHash: first.summary!.capturedRequests[0]!.envelopeHash,
        },
        {
          session: 2,
          commandId: "nl1-turn-start",
          envelopeHash: first.summary!.capturedRequests[0]!.envelopeHash,
        },
      ],
    );
    assert.deepEqual(
      first.summary!.capturedRequests[0]!.envelope,
      first.summary!.capturedRequests[1]!.envelope,
    );
    assert.isNotNull(first.summary!.suppressedExit);
    assert.equal(
      first.summary!.suppressedExit!.sequence,
      first.summary!.suppressedExit!.receipt.resultSequence,
    );
    assert.equal(
      first.summary!.normalizedControlTranscript,
      repeated.summary!.normalizedControlTranscript,
    );

    assert.equal(first.result.evidence.cleanup.status, "passed");
    const repeatedCleanup = await first.adapter.retryCleanup();
    assert.equal(
      repeatedCleanup.every((resource) => resource.released),
      true,
    );
    assert.equal(
      repeatedCleanup.every((resource) => resource.details.alreadyReleased === true),
      true,
    );
  });

  it("fails closed when the real adapter cannot independently prove the receipt", async () => {
    const plan = makeScenarioExecutionPlan(
      recoveryScenario,
      profile,
      SEED,
      NETWORK_RECOVERY_PROVENANCE,
    );
    const failedProof = await runPlan(plan, { receiptProof: "unavailable" });

    assert.equal(failedProof.result.status, "failed");
    assert.equal(failedProof.result.evidence.correctness.status, "passed");
    assert.equal(failedProof.result.evidence.fault.status, "failed");
    assert.equal(failedProof.result.evidence.fault.originPathUnshaped, true);
    assert.equal(failedProof.result.evidence.cleanup.status, "passed");
    assert.isNotNull(failedProof.summary);
    assert.equal(failedProof.summary!.providerSendCount, 1);
    assert.equal(failedProof.summary!.providerTurnCount, 1);
    assert.equal(failedProof.summary!.suppressedExit, null);
  });
});
