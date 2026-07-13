// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { runEnergyAmplificationScenario } from "./EnergyAmplificationHarness.integration.ts";
import {
  ENERGY_AMPLIFICATION_EXPECTED,
  ENERGY_AMPLIFICATION_SHAPE,
  makeEnergyAmplificationFixture,
  makeEnergyAmplificationProviderChunks,
} from "./fixtures/energyAmplification.ts";
import { ThreadId } from "@t3tools/contracts";

function sha256(values: Iterable<string>): string {
  const hash = NodeCrypto.createHash("sha256");
  for (const value of values) {
    hash.update(value, "utf8");
  }
  return hash.digest("hex");
}

it("generates the pathological provider stream deterministically without a checked-in blob", () => {
  const chunks = makeEnergyAmplificationProviderChunks();
  assert.equal(chunks.length, ENERGY_AMPLIFICATION_SHAPE.providerChunkCount);
  assert.equal(
    chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk, "utf8"), 0),
    ENERGY_AMPLIFICATION_SHAPE.commandOutputBytes,
  );
  assert.equal(sha256(chunks), ENERGY_AMPLIFICATION_EXPECTED.commandOutputSha256);
  assert.equal(
    sha256([ENERGY_AMPLIFICATION_EXPECTED.finalTranscript]),
    ENERGY_AMPLIFICATION_EXPECTED.finalTranscriptSha256,
  );

  const fixture = makeEnergyAmplificationFixture({
    threadId: ThreadId.make("deterministic-energy-fixture"),
  });
  assert.equal(fixture.response.events.length, ENERGY_AMPLIFICATION_SHAPE.providerChunkCount + 4);
});

it.live("preserves transcript and replay semantics when the stress turn is interrupted", () =>
  runEnergyAmplificationScenario({
    providerChunkCount: 96,
    commandOutputBytes: 256 * 1024,
    terminalState: "interrupted",
  }).pipe(
    Effect.tap((metrics) =>
      Effect.sync(() => {
        assert.equal(metrics.fixture.terminalState, "interrupted");
        assert.equal(
          metrics.correctness.finalTranscriptSha256,
          ENERGY_AMPLIFICATION_EXPECTED.finalTranscriptSha256,
        );
        assert.equal(metrics.correctness.replayExact, true);
        assert.equal(metrics.correctness.sessionStatus, "interrupted");
        assert.equal(metrics.correctness.latestTurnState, "interrupted");
        assert.equal(metrics.correctness.latestTurnStateAfterReconnect, "interrupted");
        assert.equal(
          metrics.correctness.transcriptSha256AfterReconnect,
          ENERGY_AMPLIFICATION_EXPECTED.finalTranscriptSha256,
        );
      }),
    ),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);

it.live("bounds durable work for the 9,200-chunk file-backed SQLite regression", () =>
  runEnergyAmplificationScenario().pipe(
    Effect.tap((metrics) =>
      Effect.sync(() => {
        assert.equal(metrics.fixture.providerChunkCount, 9_200);
        assert.equal(metrics.fixture.commandOutputBytes, 22 * 1024 * 1024);
        assert.equal(
          metrics.fixture.commandOutputSha256,
          ENERGY_AMPLIFICATION_EXPECTED.commandOutputSha256,
        );
        assert.equal(
          metrics.correctness.finalTranscriptSha256,
          ENERGY_AMPLIFICATION_EXPECTED.finalTranscriptSha256,
        );
        assert.equal(metrics.correctness.replayExact, true);
        assert.equal(metrics.correctness.sessionStatus, "ready");
        assert.equal(metrics.correctness.latestTurnState, "completed");
        assert.equal(metrics.correctness.latestTurnStateAfterReconnect, "completed");
        assert.equal(
          metrics.correctness.transcriptSha256AfterReconnect,
          ENERGY_AMPLIFICATION_EXPECTED.finalTranscriptSha256,
        );
        assert.isBelow(metrics.durable.eventCount, 100);
        assert.isBelow(metrics.database.growthBytesAfterCheckpoint, 5 * 1024 * 1024);
        assert.isAtLeast(
          metrics.workload.counters["ingestion.activity.unchanged_suppressed"] ?? 0,
          9_200,
        );
        assert.isBelow(metrics.workload.counters["ingestion.activity.published"] ?? 0, 100);
        assert.isBelow(
          metrics.workload.counters["projection.applied"] ?? 0,
          metrics.workload.counters["projection.candidates"] ?? 0,
        );
        assert.equal(
          metrics.workload.gaugesAfter["ingestion.subagent_coalescers.active"],
          metrics.workload.gaugesBefore["ingestion.subagent_coalescers.active"],
        );
      }),
    ),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);
