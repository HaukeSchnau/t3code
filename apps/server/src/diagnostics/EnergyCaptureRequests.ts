import {
  ENERGY_DIAGNOSTICS_CAPTURE_WAIT_SLACK_MS,
  EnergyDiagnosticsCaptureClaimToken,
  EnergyDiagnosticsCaptureRequestId,
  type EnergyDiagnosticsCaptureClaimInput,
  type EnergyDiagnosticsCaptureClaimResult,
  type EnergyDiagnosticsCaptureCompletionInput,
  type EnergyDiagnosticsCaptureFailureInput,
  type EnergyDiagnosticsCaptureRequest,
  type EnergyDiagnosticsCaptureRequestInput,
  type EnergyDiagnosticsCaptureReleaseInput,
  type EnergyDiagnosticsCaptureReleaseResult,
  type EnergyDiagnosticsCaptureResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "node:crypto";

const MIN_WAIT_TIMEOUT_MS = 30_000;

interface PendingCapture {
  readonly request: EnergyDiagnosticsCaptureRequest;
  readonly deferred: Deferred.Deferred<EnergyDiagnosticsCaptureResult>;
  readonly claimToken: EnergyDiagnosticsCaptureClaimToken | null;
}

export class EnergyCaptureRequests extends Context.Service<
  EnergyCaptureRequests,
  {
    readonly requestCapture: (
      input: EnergyDiagnosticsCaptureRequestInput,
    ) => Effect.Effect<EnergyDiagnosticsCaptureResult>;
    readonly claimCapture: (
      input: EnergyDiagnosticsCaptureClaimInput,
    ) => Effect.Effect<EnergyDiagnosticsCaptureClaimResult>;
    readonly releaseCapture: (
      input: EnergyDiagnosticsCaptureReleaseInput,
    ) => Effect.Effect<EnergyDiagnosticsCaptureReleaseResult>;
    readonly completeCapture: (
      input: EnergyDiagnosticsCaptureCompletionInput,
    ) => Effect.Effect<EnergyDiagnosticsCaptureResult>;
    readonly failCapture: (
      input: EnergyDiagnosticsCaptureFailureInput,
    ) => Effect.Effect<EnergyDiagnosticsCaptureResult>;
    readonly requests: Stream.Stream<EnergyDiagnosticsCaptureRequest>;
  }
>()("t3/diagnostics/EnergyCaptureRequests") {}

function nowIso() {
  return DateTime.now.pipe(Effect.map(DateTime.formatIso));
}

function emptyCounts() {
  return {
    desktopProcessSnapshotCount: 0,
    ipcPressureSnapshotCount: 0,
    ipcChannelCount: 0,
    rendererCommitCount: 0,
    rendererLongTaskCount: 0,
  };
}

function resultFromRequest(
  request: EnergyDiagnosticsCaptureRequest,
  input: {
    readonly status: EnergyDiagnosticsCaptureResult["status"];
    readonly completedAtIso: string | null;
    readonly artifactPath: string | null;
    readonly message: string | null;
    readonly desktopProcessSnapshotCount: number;
    readonly ipcPressureSnapshotCount: number;
    readonly ipcChannelCount: number;
    readonly rendererCommitCount: number;
    readonly rendererLongTaskCount: number;
  },
): EnergyDiagnosticsCaptureResult {
  return {
    requestId: request.requestId,
    requestedAtIso: request.requestedAtIso,
    durationMs: request.durationMs,
    ...input,
  };
}

function rejectedResult(input: {
  readonly requestId: EnergyDiagnosticsCaptureRequestId;
  readonly durationMs: number;
  readonly requestedAtIso: string;
  readonly message: string;
}): EnergyDiagnosticsCaptureResult {
  return {
    requestId: input.requestId,
    status: "rejected",
    requestedAtIso: input.requestedAtIso,
    completedAtIso: input.requestedAtIso,
    durationMs: input.durationMs,
    artifactPath: null,
    message: input.message,
    ...emptyCounts(),
  };
}

const make = Effect.gen(function* () {
  const requestPubSub = yield* PubSub.unbounded<EnergyDiagnosticsCaptureRequest>({ replay: 1 });
  const pendingRef = yield* Ref.make<Option.Option<PendingCapture>>(Option.none());

  const completePending = (
    requestId: EnergyDiagnosticsCaptureRequestId,
    claimToken: EnergyDiagnosticsCaptureClaimToken,
    build: (
      request: EnergyDiagnosticsCaptureRequest,
      completedAtIso: string,
    ) => EnergyDiagnosticsCaptureResult,
  ) =>
    Effect.gen(function* () {
      const pending = yield* Ref.modify(pendingRef, (current) => {
        if (
          Option.isNone(current) ||
          current.value.request.requestId !== requestId ||
          current.value.claimToken !== claimToken
        ) {
          return [Option.none<PendingCapture>(), current];
        }
        return [current, Option.none<PendingCapture>()];
      });
      const completedAtIso = yield* nowIso();
      if (Option.isNone(pending)) {
        return rejectedResult({
          requestId,
          requestedAtIso: completedAtIso,
          durationMs: 1_000,
          message: "No matching claimed energy diagnostics capture request is pending.",
        });
      }
      const result = build(pending.value.request, completedAtIso);
      yield* Deferred.succeed(pending.value.deferred, result);
      return result;
    });

  const requestCapture = (input: EnergyDiagnosticsCaptureRequestInput) =>
    Effect.gen(function* () {
      const requestedAtIso = yield* nowIso();
      const request: EnergyDiagnosticsCaptureRequest = {
        requestId: EnergyDiagnosticsCaptureRequestId.make(NodeCrypto.randomUUID()),
        requestedAtIso,
        durationMs: input.durationMs,
      };
      if (
        input.waitTimeoutMs !== undefined &&
        input.waitTimeoutMs < input.durationMs + ENERGY_DIAGNOSTICS_CAPTURE_WAIT_SLACK_MS
      ) {
        return rejectedResult({
          requestId: request.requestId,
          requestedAtIso,
          durationMs: request.durationMs,
          message: `Wait timeout must be at least the capture duration plus ${ENERGY_DIAGNOSTICS_CAPTURE_WAIT_SLACK_MS}ms.`,
        });
      }
      const deferred = yield* Deferred.make<EnergyDiagnosticsCaptureResult>();
      const pending: PendingCapture = { request, deferred, claimToken: null };
      const waitTimeoutMs =
        input.waitTimeoutMs ??
        Math.max(MIN_WAIT_TIMEOUT_MS, input.durationMs + ENERGY_DIAGNOSTICS_CAPTURE_WAIT_SLACK_MS);
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const installed = yield* Ref.modify(pendingRef, (current) => {
            if (Option.isSome(current)) {
              return [false, current];
            }
            return [true, Option.some(pending)];
          });

          if (!installed) {
            return rejectedResult({
              requestId: request.requestId,
              requestedAtIso,
              durationMs: request.durationMs,
              message: "An energy diagnostics capture is already running.",
            });
          }

          const completed = yield* restore(
            Effect.gen(function* () {
              yield* PubSub.publish(requestPubSub, request);
              return yield* Deferred.await(deferred).pipe(
                Effect.timeoutOption(Duration.millis(waitTimeoutMs)),
              );
            }),
          ).pipe(
            Effect.ensuring(
              Ref.update(pendingRef, (current) =>
                Option.isSome(current) && current.value.request.requestId === request.requestId
                  ? Option.none()
                  : current,
              ),
            ),
          );
          if (Option.isSome(completed)) {
            return completed.value;
          }

          const completedAtIso = yield* nowIso();
          return resultFromRequest(request, {
            status: "timed_out",
            completedAtIso,
            artifactPath: null,
            message:
              "Timed out waiting for a connected renderer to complete the energy diagnostics capture.",
            ...emptyCounts(),
          });
        }),
      );
    });

  const claimCapture = (input: EnergyDiagnosticsCaptureClaimInput) =>
    Effect.gen(function* () {
      const claimToken = EnergyDiagnosticsCaptureClaimToken.make(NodeCrypto.randomUUID());
      const claimed = yield* Ref.modify(pendingRef, (current) => {
        if (
          Option.isNone(current) ||
          current.value.request.requestId !== input.requestId ||
          current.value.claimToken !== null
        ) {
          return [false, current];
        }
        return [true, Option.some({ ...current.value, claimToken })];
      });
      return {
        requestId: input.requestId,
        claimToken: claimed ? claimToken : null,
      };
    });

  const releaseCapture = (input: EnergyDiagnosticsCaptureReleaseInput) =>
    Effect.gen(function* () {
      const releasedRequest = yield* Ref.modify(pendingRef, (current) => {
        if (
          Option.isNone(current) ||
          current.value.request.requestId !== input.requestId ||
          current.value.claimToken !== input.claimToken
        ) {
          return [Option.none<EnergyDiagnosticsCaptureRequest>(), current];
        }
        return [
          Option.some(current.value.request),
          Option.some({ ...current.value, claimToken: null }),
        ];
      });
      if (Option.isSome(releasedRequest)) {
        yield* PubSub.publish(requestPubSub, releasedRequest.value);
      }
      return {
        requestId: input.requestId,
        released: Option.isSome(releasedRequest),
      };
    });

  const completeCapture = (input: EnergyDiagnosticsCaptureCompletionInput) =>
    completePending(input.requestId, input.claimToken, (request, completedAtIso) =>
      resultFromRequest(request, {
        status: "completed",
        completedAtIso,
        artifactPath: input.artifactPath,
        message: null,
        desktopProcessSnapshotCount: input.desktopProcessSnapshotCount,
        ipcPressureSnapshotCount: input.ipcPressureSnapshotCount,
        ipcChannelCount: input.ipcChannelCount,
        rendererCommitCount: input.rendererCommitCount,
        rendererLongTaskCount: input.rendererLongTaskCount,
      }),
    );

  const failCapture = (input: EnergyDiagnosticsCaptureFailureInput) =>
    completePending(input.requestId, input.claimToken, (request, completedAtIso) =>
      resultFromRequest(request, {
        status: "failed",
        completedAtIso,
        artifactPath: null,
        message: input.message,
        ...emptyCounts(),
      }),
    );

  return EnergyCaptureRequests.of({
    requestCapture,
    claimCapture,
    releaseCapture,
    completeCapture,
    failCapture,
    requests: Stream.fromPubSub(requestPubSub),
  });
});

export const layer = Layer.effect(EnergyCaptureRequests, make);
