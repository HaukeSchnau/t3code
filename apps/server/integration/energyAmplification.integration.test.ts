// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { assert, it } from "@effect/vitest";

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
