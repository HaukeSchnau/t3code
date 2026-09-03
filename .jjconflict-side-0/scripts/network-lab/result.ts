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
const NonPassedEvidenceStatus = Schema.Literals(["failed", "unavailable"]);

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

export const PassedCorrectnessAssertion = Schema.Struct({
  id: NonEmptyString,
  passed: Schema.Literal(true),
  expected: Schema.Json,
  observed: Schema.Json,
});
export type PassedCorrectnessAssertion = typeof PassedCorrectnessAssertion.Type;

export const PassedCorrectnessEvidence = Schema.Struct({
  status: Schema.Literal("passed"),
  assertions: Schema.Array(PassedCorrectnessAssertion).check(Schema.isMinLength(1)),
});
export type PassedCorrectnessEvidence = typeof PassedCorrectnessEvidence.Type;

export const NonPassedCorrectnessEvidence = Schema.Struct({
  status: NonPassedEvidenceStatus,
  assertions: Schema.Array(CorrectnessAssertion),
});
export type NonPassedCorrectnessEvidence = typeof NonPassedCorrectnessEvidence.Type;

export const CorrectnessEvidence = Schema.Union([
  PassedCorrectnessEvidence,
  NonPassedCorrectnessEvidence,
]);
export type CorrectnessEvidence = typeof CorrectnessEvidence.Type;

export const FaultOperationEvidence = Schema.Struct({
  stepId: NonEmptyString,
  sequence: NonNegativeInt,
  decisionToken: NonEmptyString,
  effectiveControl: NetworkFaultControl,
  details: Schema.Record(Schema.String, Schema.Json),
});
export type FaultOperationEvidence = typeof FaultOperationEvidence.Type;

export const PassedFaultEvidence = Schema.Struct({
  status: Schema.Literal("passed"),
  originPathUnshaped: Schema.Literal(true),
  operations: Schema.Array(FaultOperationEvidence).check(Schema.isMinLength(1)),
});
export type PassedFaultEvidence = typeof PassedFaultEvidence.Type;

export const NonPassedFaultEvidence = Schema.Struct({
  status: NonPassedEvidenceStatus,
  originPathUnshaped: Schema.Boolean,
  operations: Schema.Array(FaultOperationEvidence),
});
export type NonPassedFaultEvidence = typeof NonPassedFaultEvidence.Type;

export const FaultEvidence = Schema.Union([PassedFaultEvidence, NonPassedFaultEvidence]);
export type FaultEvidence = typeof FaultEvidence.Type;

export const CleanupResourceEvidence = Schema.Struct({
  kind: NonEmptyString,
  id: NonEmptyString,
  released: Schema.Boolean,
  details: Schema.Record(Schema.String, Schema.Json),
  error: Schema.Union([NonEmptyString, Schema.Null]),
});
export type CleanupResourceEvidence = typeof CleanupResourceEvidence.Type;

export const PassedCleanupResourceEvidence = Schema.Struct({
  kind: NonEmptyString,
  id: NonEmptyString,
  released: Schema.Literal(true),
  details: Schema.Record(Schema.String, Schema.Json),
  error: Schema.Null,
});
export type PassedCleanupResourceEvidence = typeof PassedCleanupResourceEvidence.Type;

export const PassedCleanupEvidence = Schema.Struct({
  status: Schema.Literal("passed"),
  leaseId: NonEmptyString,
  resources: Schema.Array(PassedCleanupResourceEvidence).check(Schema.isMinLength(1)),
});
export type PassedCleanupEvidence = typeof PassedCleanupEvidence.Type;

export const NonPassedCleanupEvidence = Schema.Struct({
  status: NonPassedEvidenceStatus,
  leaseId: Schema.Union([NonEmptyString, Schema.Null]),
  resources: Schema.Array(CleanupResourceEvidence),
});
export type NonPassedCleanupEvidence = typeof NonPassedCleanupEvidence.Type;

export const CleanupEvidence = Schema.Union([PassedCleanupEvidence, NonPassedCleanupEvidence]);
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

const ResultBase = {
  schemaVersion: Schema.Literal(NETWORK_LAB_RESULT_SCHEMA_VERSION),
  identity: RunIdentity,
  steps: Schema.Array(StepResult),
} as const;

export const PassedNetworkLabResult = Schema.Struct({
  ...ResultBase,
  status: Schema.Literal("passed"),
  evidence: Schema.Struct({
    correctness: PassedCorrectnessEvidence,
    fault: PassedFaultEvidence,
    cleanup: PassedCleanupEvidence,
  }),
  errors: Schema.Tuple([]),
});
export type PassedNetworkLabResult = typeof PassedNetworkLabResult.Type;

export const FailedNetworkLabResult = Schema.Struct({
  ...ResultBase,
  status: Schema.Literal("failed"),
  evidence: Schema.Struct({
    correctness: CorrectnessEvidence,
    fault: FaultEvidence,
    cleanup: CleanupEvidence,
  }),
  errors: Schema.Array(RunnerErrorEvidence),
});
export type FailedNetworkLabResult = typeof FailedNetworkLabResult.Type;

export const NetworkLabResult = Schema.Union([PassedNetworkLabResult, FailedNetworkLabResult]);
export type NetworkLabResult = typeof NetworkLabResult.Type;
