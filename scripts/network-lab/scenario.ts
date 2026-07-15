import type * as Schema from "effect/Schema";

import {
  type NetworkLabScenario,
  type NetworkLabProvenance,
  type NetworkProfile,
  type PlannedScenarioStep,
  type RunIdentity,
  type ScenarioExecutionPlan,
  Seed,
} from "./model.ts";

export class NetworkLabScenarioError extends Error {
  override readonly name = "NetworkLabScenarioError";
  readonly reason: "duplicate-step-id" | "invalid-seed";

  constructor(reason: "duplicate-step-id" | "invalid-seed", message: string) {
    super(message);
    this.reason = reason;
  }
}

function canonicalize(value: Schema.Json): Schema.Json {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value: Schema.Json): string {
  return JSON.stringify(canonicalize(value));
}

function fnv1a64(value: string): string {
  let hash = 0xcbf2_9ce4_8422_2325n;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x0000_0100_0000_01b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function makeRandom(seed: number): () => number {
  let state = seed === 0 ? 0x6d2b_79f5 : seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function decisionToken(random: () => number): string {
  return Math.floor(random() * 0x1_0000_0000)
    .toString(16)
    .padStart(8, "0");
}

function assertUniqueStepIds(scenario: NetworkLabScenario): void {
  const seen = new Set<string>();
  for (const step of scenario.steps) {
    if (seen.has(step.id)) {
      throw new NetworkLabScenarioError(
        "duplicate-step-id",
        `Scenario step id "${step.id}" is duplicated.`,
      );
    }
    seen.add(step.id);
  }
}

function assertSeed(seed: number): asserts seed is typeof Seed.Type {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new NetworkLabScenarioError(
      "invalid-seed",
      `Scenario seed must be an unsigned 32-bit integer; received ${String(seed)}.`,
    );
  }
}

export function makeScenarioExecutionPlan(
  scenario: NetworkLabScenario,
  profile: NetworkProfile,
  seed: number,
  provenance: NetworkLabProvenance,
): ScenarioExecutionPlan {
  assertSeed(seed);
  assertUniqueStepIds(scenario);

  const definitionHash = fnv1a64(canonicalJson({ profile, provenance, scenario }));
  const executionId = [
    `${scenario.identity.id}@${String(scenario.identity.version)}`,
    `${profile.identity.id}@${String(profile.identity.version)}`,
    `seed-${String(seed)}`,
    definitionHash,
  ].join("/");
  const identity = {
    scenario: scenario.identity,
    profile: profile.identity,
    provenance,
    seed,
    executionId,
    definitionHash,
  } satisfies RunIdentity;
  const random = makeRandom(seed);
  const steps = scenario.steps.map(
    (step, sequence) =>
      ({
        sequence,
        decisionToken: decisionToken(random),
        step,
      }) satisfies PlannedScenarioStep,
  );

  return { identity, scenario, profile, provenance, steps };
}
