import * as Schema from "effect/Schema";

import {
  NETWORK_LAB_RESULT_SCHEMA_VERSION,
  NetworkFaultControl,
  NonEmptyString,
  NonNegativeInt,
  RunIdentity,
} from "./model.ts";

export const EvidenceStatus = Schema.Literals(["passed", "failed", "unavailable"]);
export type EvidenceStatus = typeof EvidenceStatus.Type;

export const ObservationEvidence = Schema.Struct({
  key: NonEmptyString,
  sequence: NonNegativeInt,
  details: Schema.Record(Schema.String, Schema.Json),
});
export type ObservationEvidence = typeof ObservationEvidence.Type;

export const CorrectnessAssertion = Schema.Struct({
  id: NonEmptyString,
  passed: Schema.Boolean,
  expected: Schema.Json,
  observed: Schema.Json,
});
export type CorrectnessAssertion = typeof CorrectnessAssertion.Type;

export const CorrectnessEvidence = Schema.Struct({
  status: EvidenceStatus,
  assertions: Schema.Array(CorrectnessAssertion),
});
export type CorrectnessEvidence = typeof CorrectnessEvidence.Type;

export const FaultOperationEvidence = Schema.Struct({
  stepId: NonEmptyString,
  sequence: NonNegativeInt,
  decisionToken: NonEmptyString,
  effectiveControl: NetworkFaultControl,
  details: Schema.Record(Schema.String, Schema.Json),
});
export type FaultOperationEvidence = typeof FaultOperationEvidence.Type;

export const FaultEvidence = Schema.Struct({
  status: EvidenceStatus,
  originPathUnshaped: Schema.Boolean,
  operations: Schema.Array(FaultOperationEvidence),
});
export type FaultEvidence = typeof FaultEvidence.Type;

export const CleanupResourceEvidence = Schema.Struct({
  kind: NonEmptyString,
  id: NonEmptyString,
  released: Schema.Boolean,
  details: Schema.Record(Schema.String, Schema.Json),
  error: Schema.Union([NonEmptyString, Schema.Null]),
});
export type CleanupResourceEvidence = typeof CleanupResourceEvidence.Type;

export const CleanupEvidence = Schema.Struct({
  status: EvidenceStatus,
  leaseId: Schema.Union([NonEmptyString, Schema.Null]),
  resources: Schema.Array(CleanupResourceEvidence),
});
export type CleanupEvidence = typeof CleanupEvidence.Type;

export const RunnerPhase = Schema.Literals([
  "prepare",
  "step",
  "correctness-evidence",
  "fault-evidence",
  "cleanup",
]);
export type RunnerPhase = typeof RunnerPhase.Type;

export const RunnerErrorEvidence = Schema.Struct({
  phase: RunnerPhase,
  stepId: Schema.Union([NonEmptyString, Schema.Null]),
  resourceId: Schema.Union([NonEmptyString, Schema.Null]),
  name: NonEmptyString,
  message: NonEmptyString,
});
export type RunnerErrorEvidence = typeof RunnerErrorEvidence.Type;

export const StepResult = Schema.Struct({
  id: NonEmptyString,
  sequence: NonNegativeInt,
  decisionToken: NonEmptyString,
  kind: Schema.Literals(["action", "control", "checkpoint"]),
  status: Schema.Literals(["passed", "failed"]),
  observation: Schema.Union([ObservationEvidence, Schema.Null]),
});
export type StepResult = typeof StepResult.Type;

export const NetworkLabResult = Schema.Struct({
  schemaVersion: Schema.Literal(NETWORK_LAB_RESULT_SCHEMA_VERSION),
  identity: RunIdentity,
  status: Schema.Literals(["passed", "failed"]),
  steps: Schema.Array(StepResult),
  evidence: Schema.Struct({
    correctness: CorrectnessEvidence,
    fault: FaultEvidence,
    cleanup: CleanupEvidence,
  }),
  errors: Schema.Array(RunnerErrorEvidence),
});
export type NetworkLabResult = typeof NetworkLabResult.Type;
