import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ENERGY_DIAGNOSTICS_CAPTURE_WAIT_SLACK_MS = 15_000;

export const EnergyDiagnosticsCaptureRequestId = TrimmedNonEmptyString.pipe(
  Schema.brand("EnergyDiagnosticsCaptureRequestId"),
);
export type EnergyDiagnosticsCaptureRequestId = typeof EnergyDiagnosticsCaptureRequestId.Type;

export const EnergyDiagnosticsCaptureClaimToken = TrimmedNonEmptyString.pipe(
  Schema.brand("EnergyDiagnosticsCaptureClaimToken"),
);
export type EnergyDiagnosticsCaptureClaimToken = typeof EnergyDiagnosticsCaptureClaimToken.Type;

export const EnergyDiagnosticsCaptureArtifactPath = TrimmedNonEmptyString.pipe(
  Schema.brand("EnergyDiagnosticsCaptureArtifactPath"),
);
export type EnergyDiagnosticsCaptureArtifactPath = typeof EnergyDiagnosticsCaptureArtifactPath.Type;

export const EnergyDiagnosticsCaptureDurationMs = PositiveInt.check(
  Schema.isBetween({ minimum: 1_000, maximum: 300_000 }),
);
export type EnergyDiagnosticsCaptureDurationMs = typeof EnergyDiagnosticsCaptureDurationMs.Type;

export const EnergyDiagnosticsCaptureWaitTimeoutMs = PositiveInt.check(
  Schema.isBetween({ minimum: 1_000, maximum: 600_000 }),
);
export type EnergyDiagnosticsCaptureWaitTimeoutMs =
  typeof EnergyDiagnosticsCaptureWaitTimeoutMs.Type;

export const EnergyDiagnosticsCaptureRequestInput = Schema.Struct({
  durationMs: EnergyDiagnosticsCaptureDurationMs,
  waitTimeoutMs: Schema.optional(EnergyDiagnosticsCaptureWaitTimeoutMs),
});
export type EnergyDiagnosticsCaptureRequestInput = typeof EnergyDiagnosticsCaptureRequestInput.Type;

export const EnergyDiagnosticsCaptureRequest = Schema.Struct({
  requestId: EnergyDiagnosticsCaptureRequestId,
  requestedAtIso: IsoDateTime,
  durationMs: EnergyDiagnosticsCaptureDurationMs,
});
export type EnergyDiagnosticsCaptureRequest = typeof EnergyDiagnosticsCaptureRequest.Type;

export const EnergyDiagnosticsCaptureClaimInput = Schema.Struct({
  requestId: EnergyDiagnosticsCaptureRequestId,
});
export type EnergyDiagnosticsCaptureClaimInput = typeof EnergyDiagnosticsCaptureClaimInput.Type;

export const EnergyDiagnosticsCaptureClaimResult = Schema.Struct({
  requestId: EnergyDiagnosticsCaptureRequestId,
  claimToken: Schema.NullOr(EnergyDiagnosticsCaptureClaimToken),
});
export type EnergyDiagnosticsCaptureClaimResult = typeof EnergyDiagnosticsCaptureClaimResult.Type;

export const EnergyDiagnosticsCaptureReleaseInput = Schema.Struct({
  requestId: EnergyDiagnosticsCaptureRequestId,
  claimToken: EnergyDiagnosticsCaptureClaimToken,
});
export type EnergyDiagnosticsCaptureReleaseInput = typeof EnergyDiagnosticsCaptureReleaseInput.Type;

export const EnergyDiagnosticsCaptureReleaseResult = Schema.Struct({
  requestId: EnergyDiagnosticsCaptureRequestId,
  released: Schema.Boolean,
});
export type EnergyDiagnosticsCaptureReleaseResult =
  typeof EnergyDiagnosticsCaptureReleaseResult.Type;

export const EnergyDiagnosticsCaptureStatus = Schema.Literals([
  "completed",
  "failed",
  "rejected",
  "timed_out",
]);
export type EnergyDiagnosticsCaptureStatus = typeof EnergyDiagnosticsCaptureStatus.Type;

export const EnergyDiagnosticsCaptureCompletionInput = Schema.Struct({
  requestId: EnergyDiagnosticsCaptureRequestId,
  claimToken: EnergyDiagnosticsCaptureClaimToken,
  artifactPath: EnergyDiagnosticsCaptureArtifactPath,
  desktopProcessSnapshotCount: NonNegativeInt,
  ipcPressureSnapshotCount: NonNegativeInt,
  ipcChannelCount: NonNegativeInt,
  rendererCommitCount: NonNegativeInt,
  rendererLongTaskCount: NonNegativeInt,
});
export type EnergyDiagnosticsCaptureCompletionInput =
  typeof EnergyDiagnosticsCaptureCompletionInput.Type;

export const EnergyDiagnosticsCaptureFailureInput = Schema.Struct({
  requestId: EnergyDiagnosticsCaptureRequestId,
  claimToken: EnergyDiagnosticsCaptureClaimToken,
  message: TrimmedNonEmptyString,
});
export type EnergyDiagnosticsCaptureFailureInput = typeof EnergyDiagnosticsCaptureFailureInput.Type;

export const EnergyDiagnosticsCaptureResult = Schema.Struct({
  requestId: EnergyDiagnosticsCaptureRequestId,
  status: EnergyDiagnosticsCaptureStatus,
  requestedAtIso: IsoDateTime,
  completedAtIso: Schema.NullOr(IsoDateTime),
  durationMs: EnergyDiagnosticsCaptureDurationMs,
  artifactPath: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
  desktopProcessSnapshotCount: NonNegativeInt,
  ipcPressureSnapshotCount: NonNegativeInt,
  ipcChannelCount: NonNegativeInt,
  rendererCommitCount: NonNegativeInt,
  rendererLongTaskCount: NonNegativeInt,
});
export type EnergyDiagnosticsCaptureResult = typeof EnergyDiagnosticsCaptureResult.Type;
