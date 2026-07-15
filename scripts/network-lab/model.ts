import * as Schema from "effect/Schema";

export const NETWORK_LAB_SCENARIO_SCHEMA_VERSION = 1 as const;
export const NETWORK_LAB_CONTROL_SCHEMA_VERSION = 1 as const;
export const NETWORK_LAB_RESULT_SCHEMA_VERSION = 1 as const;

export const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
export const Seed = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0xffff_ffff }));

export const VersionedIdentity = Schema.Struct({ id: NonEmptyString, version: PositiveInt });
export type VersionedIdentity = typeof VersionedIdentity.Type;

export const NetworkLabProvenance = Schema.Struct({
  lab: VersionedIdentity,
  adapter: VersionedIdentity,
});
export type NetworkLabProvenance = typeof NetworkLabProvenance.Type;

export const NetworkLinkProfile = Schema.Struct({
  latencyMs: NonNegativeInt,
  jitterMs: NonNegativeInt,
  lossPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  bandwidthKbps: Schema.Union([PositiveInt, Schema.Null]),
});
export type NetworkLinkProfile = typeof NetworkLinkProfile.Type;

export const NetworkImpairmentSemantics = Schema.Struct({
  latency: Schema.Literal("constant-one-way-delay-ms-v1"),
  jitter: Schema.Literal("uniform-plus-or-minus-delay-ms-clamped-at-zero-v1"),
  loss: Schema.Literal("independent-per-packet-percent-v1"),
  bandwidth: Schema.Struct({
    limited: Schema.Literal("maximum-throughput-kilobits-per-second-v1"),
    unlimited: Schema.Literal("null-means-unlimited-no-rate-limit-v1"),
  }),
});
export type NetworkImpairmentSemantics = typeof NetworkImpairmentSemantics.Type;

export const NetworkProfile = Schema.Struct({
  schemaVersion: Schema.Literal(NETWORK_LAB_SCENARIO_SCHEMA_VERSION),
  identity: VersionedIdentity,
  clientPath: NetworkLinkProfile,
  semantics: NetworkImpairmentSemantics,
  originPath: Schema.Literal("unshaped"),
});
export type NetworkProfile = typeof NetworkProfile.Type;

export const ClientPathDirection = Schema.Literals([
  "client-to-origin",
  "origin-to-client",
  "bidirectional",
]);
export type ClientPathDirection = typeof ClientPathDirection.Type;

export const ControlLifecycle = Schema.Literals(["apply", "remove"]);
export type ControlLifecycle = typeof ControlLifecycle.Type;

const VersionedControl = {
  schemaVersion: Schema.Literal(NETWORK_LAB_CONTROL_SCHEMA_VERSION),
} as const;

export const LinkOfflineControl = Schema.Struct({
  ...VersionedControl,
  kind: Schema.Literal("link-state"),
  surface: Schema.Literal("client-path"),
  direction: Schema.Literal("bidirectional"),
  lifecycle: Schema.Literal("apply"),
  state: Schema.Literal("offline"),
  semantics: Schema.Literal("administrative-link-state-v1"),
});
export type LinkOfflineControl = typeof LinkOfflineControl.Type;

export const LinkOnlineControl = Schema.Struct({
  ...VersionedControl,
  kind: Schema.Literal("link-state"),
  surface: Schema.Literal("client-path"),
  direction: Schema.Literal("bidirectional"),
  lifecycle: Schema.Literal("remove"),
  state: Schema.Literal("online"),
  semantics: Schema.Literal("administrative-link-state-v1"),
});
export type LinkOnlineControl = typeof LinkOnlineControl.Type;

export const LinkStateControl = Schema.Union([LinkOfflineControl, LinkOnlineControl]);
export type LinkStateControl = typeof LinkStateControl.Type;

export const DataPlaneBlackholeControl = Schema.Struct({
  ...VersionedControl,
  kind: Schema.Literal("data-plane-blackhole"),
  surface: Schema.Literal("client-path"),
  direction: ClientPathDirection,
  lifecycle: ControlLifecycle,
  semantics: Schema.Literal("drop-all-matching-data-plane-packets-v1"),
});
export type DataPlaneBlackholeControl = typeof DataPlaneBlackholeControl.Type;

export const DataPlaneResetControl = Schema.Struct({
  ...VersionedControl,
  kind: Schema.Literal("data-plane-reset"),
  surface: Schema.Literal("client-path"),
  direction: ClientPathDirection,
  lifecycle: Schema.Literal("apply"),
  semantics: Schema.Literal("terminate-active-matching-connections-v1"),
});
export type DataPlaneResetControl = typeof DataPlaneResetControl.Type;

export const DirectionalImpairmentControl = Schema.Struct({
  ...VersionedControl,
  kind: Schema.Literal("directional-impairment"),
  surface: Schema.Literal("client-path"),
  direction: ClientPathDirection,
  lifecycle: ControlLifecycle,
  parameters: NetworkLinkProfile,
  semantics: NetworkImpairmentSemantics,
});
export type DirectionalImpairmentControl = typeof DirectionalImpairmentControl.Type;

export const ProtocolSuppressionControl = Schema.Struct({
  ...VersionedControl,
  kind: Schema.Literal("protocol-suppression"),
  surface: Schema.Literal("application-protocol"),
  direction: Schema.Literals(["client-to-origin", "origin-to-client"]),
  lifecycle: ControlLifecycle,
  protocol: NonEmptyString,
  message: Schema.Literals(["acknowledgement", "response"]),
  count: PositiveInt,
  semantics: Schema.Literal("suppress-next-matching-complete-protocol-message-v1"),
});
export type ProtocolSuppressionControl = typeof ProtocolSuppressionControl.Type;

export const NetworkFaultControl = Schema.Union([
  LinkStateControl,
  DataPlaneBlackholeControl,
  DataPlaneResetControl,
  DirectionalImpairmentControl,
  ProtocolSuppressionControl,
]);
export type NetworkFaultControl = typeof NetworkFaultControl.Type;

export const ScenarioActionStep = Schema.Struct({
  kind: Schema.Literal("action"),
  id: NonEmptyString,
  action: NonEmptyString.check(Schema.isPattern(/^(?!fault\.).+/)),
  parameters: Schema.Record(Schema.String, Schema.Json),
});
export type ScenarioActionStep = typeof ScenarioActionStep.Type;

export const ScenarioControlStep = Schema.Struct({
  kind: Schema.Literal("control"),
  id: NonEmptyString,
  control: NetworkFaultControl,
});
export type ScenarioControlStep = typeof ScenarioControlStep.Type;

export const ScenarioCheckpointStep = Schema.Struct({
  kind: Schema.Literal("checkpoint"),
  id: NonEmptyString,
  checkpoint: NonEmptyString,
  timeoutMs: PositiveInt,
});
export type ScenarioCheckpointStep = typeof ScenarioCheckpointStep.Type;

export const ScenarioStep = Schema.Union([
  ScenarioActionStep,
  ScenarioControlStep,
  ScenarioCheckpointStep,
]);
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
  provenance: NetworkLabProvenance,
  seed: Seed,
  executionId: NonEmptyString,
  definitionHash: NonEmptyString,
});
export type RunIdentity = typeof RunIdentity.Type;

export const CleanupResource = Schema.Struct({ kind: NonEmptyString, id: NonEmptyString });
export type CleanupResource = typeof CleanupResource.Type;

export const ResourceLease = Schema.Struct({
  id: NonEmptyString,
  resources: Schema.Array(CleanupResource).check(Schema.isMinLength(1)),
});
export type ResourceLease = typeof ResourceLease.Type;

export interface PlannedScenarioStep {
  readonly sequence: number;
  readonly decisionToken: string;
  readonly step: ScenarioStep;
}

export interface ScenarioExecutionPlan {
  readonly identity: RunIdentity;
  readonly scenario: NetworkLabScenario;
  readonly profile: NetworkProfile;
  readonly provenance: NetworkLabProvenance;
  readonly steps: ReadonlyArray<PlannedScenarioStep>;
}
