import * as Schema from "effect/Schema";

export const NETWORK_LAB_SCENARIO_SCHEMA_VERSION = 1 as const;
export const NETWORK_LAB_RESULT_SCHEMA_VERSION = 1 as const;

export const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
export const Seed = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0xffff_ffff }));

export const VersionedIdentity = Schema.Struct({
  id: NonEmptyString,
  version: PositiveInt,
});
export type VersionedIdentity = typeof VersionedIdentity.Type;

export const NetworkLinkProfile = Schema.Struct({
  latencyMs: NonNegativeInt,
  jitterMs: NonNegativeInt,
  lossPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  bandwidthKbps: Schema.Union([PositiveInt, Schema.Null]),
});
export type NetworkLinkProfile = typeof NetworkLinkProfile.Type;

export const NetworkProfile = Schema.Struct({
  schemaVersion: Schema.Literal(NETWORK_LAB_SCENARIO_SCHEMA_VERSION),
  identity: VersionedIdentity,
  clientPath: NetworkLinkProfile,
  originPath: Schema.Literal("unshaped"),
});
export type NetworkProfile = typeof NetworkProfile.Type;

export const ScenarioActionStep = Schema.Struct({
  kind: Schema.Literal("action"),
  id: NonEmptyString,
  action: NonEmptyString,
  parameters: Schema.Record(Schema.String, Schema.Json),
});
export type ScenarioActionStep = typeof ScenarioActionStep.Type;

export const ScenarioCheckpointStep = Schema.Struct({
  kind: Schema.Literal("checkpoint"),
  id: NonEmptyString,
  checkpoint: NonEmptyString,
  timeoutMs: PositiveInt,
});
export type ScenarioCheckpointStep = typeof ScenarioCheckpointStep.Type;

export const ScenarioStep = Schema.Union([ScenarioActionStep, ScenarioCheckpointStep]);
export type ScenarioStep = typeof ScenarioStep.Type;

export const NetworkLabScenario = Schema.Struct({
  schemaVersion: Schema.Literal(NETWORK_LAB_SCENARIO_SCHEMA_VERSION),
  identity: VersionedIdentity,
  topology: Schema.Literals(["direct", "managed-relay"]),
  steps: Schema.Array(ScenarioStep),
});
export type NetworkLabScenario = typeof NetworkLabScenario.Type;

export const RunIdentity = Schema.Struct({
  scenario: VersionedIdentity,
  profile: VersionedIdentity,
  seed: Seed,
  executionId: NonEmptyString,
  definitionHash: NonEmptyString,
});
export type RunIdentity = typeof RunIdentity.Type;

export interface PlannedScenarioStep {
  readonly sequence: number;
  readonly decisionToken: string;
  readonly step: ScenarioStep;
}

export interface ScenarioExecutionPlan {
  readonly identity: RunIdentity;
  readonly scenario: NetworkLabScenario;
  readonly profile: NetworkProfile;
  readonly steps: ReadonlyArray<PlannedScenarioStep>;
}
