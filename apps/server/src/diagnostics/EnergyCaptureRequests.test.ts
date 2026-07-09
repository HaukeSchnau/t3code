import { describe, expect, it } from "@effect/vitest";
import {
  EnergyDiagnosticsCaptureArtifactPath,
  EnergyDiagnosticsCaptureClaimToken,
  type EnergyDiagnosticsCaptureRequest,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as EnergyCaptureRequests from "./EnergyCaptureRequests.ts";

function collectRequests(service: EnergyCaptureRequests.EnergyCaptureRequests["Service"]) {
  return Effect.gen(function* () {
    const queue = yield* Queue.unbounded<EnergyDiagnosticsCaptureRequest>();
    yield* service.requests.pipe(
      Stream.runForEach((request) => Queue.offer(queue, request)),
      Effect.forkScoped,
    );
    return queue;
  });
}

describe("EnergyCaptureRequests", () => {
  it.effect("publishes a request and resolves with the renderer completion", () =>
    Effect.gen(function* () {
      const service = yield* EnergyCaptureRequests.EnergyCaptureRequests;
      const requests = yield* collectRequests(service);
      const captureFiber = yield* service
        .requestCapture({ durationMs: 1_000, waitTimeoutMs: 16_000 })
        .pipe(Effect.forkScoped);
      const request = yield* Queue.take(requests);
      const claim = yield* service.claimCapture({ requestId: request.requestId });

      expect(claim.claimToken).not.toBeNull();
      if (claim.claimToken === null) {
        return yield* Effect.die(new Error("Expected the capture request claim to succeed."));
      }

      const reported = yield* service.completeCapture({
        requestId: request.requestId,
        claimToken: claim.claimToken,
        artifactPath: EnergyDiagnosticsCaptureArtifactPath.make("/tmp/t3-energy.json"),
        desktopProcessSnapshotCount: 2,
        ipcPressureSnapshotCount: 2,
        ipcChannelCount: 3,
        rendererCommitCount: 4,
        rendererLongTaskCount: 1,
      });
      const awaited = yield* Fiber.join(captureFiber);

      expect(awaited).toEqual(reported);
      expect(awaited.status).toBe("completed");
      expect(awaited.artifactPath).toBe("/tmp/t3-energy.json");
      expect(awaited.rendererCommitCount).toBe(4);
    }).pipe(Effect.provide(EnergyCaptureRequests.layer)),
  );

  it.effect("rejects overlapping capture requests", () =>
    Effect.gen(function* () {
      const service = yield* EnergyCaptureRequests.EnergyCaptureRequests;
      const requests = yield* collectRequests(service);
      const firstFiber = yield* service
        .requestCapture({ durationMs: 1_000, waitTimeoutMs: 16_000 })
        .pipe(Effect.forkScoped);
      const firstRequest = yield* Queue.take(requests);
      const claim = yield* service.claimCapture({ requestId: firstRequest.requestId });

      expect(claim.claimToken).not.toBeNull();
      if (claim.claimToken === null) {
        return yield* Effect.die(new Error("Expected the first capture request claim to succeed."));
      }

      const second = yield* service.requestCapture({
        durationMs: 1_000,
        waitTimeoutMs: 16_000,
      });
      expect(second.status).toBe("rejected");
      expect(second.message).toBe("An energy diagnostics capture is already running.");

      const reported = yield* service.failCapture({
        requestId: firstRequest.requestId,
        claimToken: claim.claimToken,
        message: "Renderer capture failed during test cleanup.",
      });
      const first = yield* Fiber.join(firstFiber);

      expect(first).toEqual(reported);
      expect(first.status).toBe("failed");
    }).pipe(Effect.provide(EnergyCaptureRequests.layer)),
  );

  it.effect("times out and rejects late renderer completions", () =>
    Effect.gen(function* () {
      const service = yield* EnergyCaptureRequests.EnergyCaptureRequests;
      const requests = yield* collectRequests(service);
      const captureFiber = yield* service
        .requestCapture({ durationMs: 1_000, waitTimeoutMs: 16_000 })
        .pipe(Effect.forkScoped);
      const request = yield* Queue.take(requests);
      const claim = yield* service.claimCapture({ requestId: request.requestId });

      expect(claim.claimToken).not.toBeNull();
      if (claim.claimToken === null) {
        return yield* Effect.die(new Error("Expected the capture request claim to succeed."));
      }

      yield* TestClock.adjust(Duration.seconds(16));
      const timedOut = yield* Fiber.join(captureFiber);
      expect(timedOut.status).toBe("timed_out");

      const lateCompletion = yield* service.completeCapture({
        requestId: request.requestId,
        claimToken: claim.claimToken,
        artifactPath: EnergyDiagnosticsCaptureArtifactPath.make("/tmp/late.json"),
        desktopProcessSnapshotCount: 1,
        ipcPressureSnapshotCount: 1,
        ipcChannelCount: 1,
        rendererCommitCount: 1,
        rendererLongTaskCount: 1,
      });
      expect(lateCompletion.status).toBe("rejected");
      expect(lateCompletion.message).toBe(
        "No matching claimed energy diagnostics capture request is pending.",
      );
    }).pipe(Effect.provide(Layer.merge(EnergyCaptureRequests.layer, TestClock.layer()))),
  );

  it.effect("replays a pending request to a late subscriber", () =>
    Effect.gen(function* () {
      const service = yield* EnergyCaptureRequests.EnergyCaptureRequests;
      const captureFiber = yield* service
        .requestCapture({ durationMs: 1_000, waitTimeoutMs: 16_000 })
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      const requests = yield* collectRequests(service);
      const request = yield* Queue.take(requests);
      const claim = yield* service.claimCapture({ requestId: request.requestId });

      expect(claim.claimToken).not.toBeNull();
      if (claim.claimToken === null) {
        return yield* Effect.die(
          new Error("Expected the replayed capture request claim to succeed."),
        );
      }

      const reported = yield* service.completeCapture({
        requestId: request.requestId,
        claimToken: claim.claimToken,
        artifactPath: EnergyDiagnosticsCaptureArtifactPath.make("/tmp/replayed.json"),
        desktopProcessSnapshotCount: 1,
        ipcPressureSnapshotCount: 1,
        ipcChannelCount: 1,
        rendererCommitCount: 1,
        rendererLongTaskCount: 0,
      });
      const awaited = yield* Fiber.join(captureFiber);

      expect(awaited).toEqual(reported);
      expect(awaited.status).toBe("completed");
    }).pipe(Effect.provide(EnergyCaptureRequests.layer)),
  );

  it.effect("allows exactly one claim and keeps pending state after a wrong token", () =>
    Effect.gen(function* () {
      const service = yield* EnergyCaptureRequests.EnergyCaptureRequests;
      const requests = yield* collectRequests(service);
      const captureFiber = yield* service
        .requestCapture({ durationMs: 1_000, waitTimeoutMs: 16_000 })
        .pipe(Effect.forkScoped);
      const request = yield* Queue.take(requests);

      const claims = yield* Effect.all(
        [
          service.claimCapture({ requestId: request.requestId }),
          service.claimCapture({ requestId: request.requestId }),
        ],
        { concurrency: "unbounded" },
      );
      const winningTokens = claims.flatMap(({ claimToken }) =>
        claimToken === null ? [] : [claimToken],
      );

      expect(winningTokens).toHaveLength(1);
      const winningToken = winningTokens[0];
      if (winningToken === undefined) {
        return yield* Effect.die(new Error("Expected exactly one capture request claim to win."));
      }

      const wrongCompletion = yield* service.completeCapture({
        requestId: request.requestId,
        claimToken: EnergyDiagnosticsCaptureClaimToken.make("wrong-claim-token"),
        artifactPath: EnergyDiagnosticsCaptureArtifactPath.make("/tmp/wrong-token.json"),
        desktopProcessSnapshotCount: 0,
        ipcPressureSnapshotCount: 0,
        ipcChannelCount: 0,
        rendererCommitCount: 0,
        rendererLongTaskCount: 0,
      });
      expect(wrongCompletion.status).toBe("rejected");

      const reported = yield* service.completeCapture({
        requestId: request.requestId,
        claimToken: winningToken,
        artifactPath: EnergyDiagnosticsCaptureArtifactPath.make("/tmp/claimed.json"),
        desktopProcessSnapshotCount: 2,
        ipcPressureSnapshotCount: 2,
        ipcChannelCount: 3,
        rendererCommitCount: 4,
        rendererLongTaskCount: 1,
      });
      const awaited = yield* Fiber.join(captureFiber);

      expect(awaited).toEqual(reported);
      expect(awaited.status).toBe("completed");
      expect(awaited.artifactPath).toBe("/tmp/claimed.json");
    }).pipe(Effect.provide(EnergyCaptureRequests.layer)),
  );

  it.effect("releases a failed renderer claim so another renderer can recover", () =>
    Effect.gen(function* () {
      const service = yield* EnergyCaptureRequests.EnergyCaptureRequests;
      const requests = yield* collectRequests(service);
      const captureFiber = yield* service
        .requestCapture({ durationMs: 1_000, waitTimeoutMs: 16_000 })
        .pipe(Effect.forkScoped);
      const request = yield* Queue.take(requests);
      const firstClaim = yield* service.claimCapture({ requestId: request.requestId });
      if (firstClaim.claimToken === null) {
        return yield* Effect.die(new Error("Expected the first renderer claim to succeed."));
      }

      const released = yield* service.releaseCapture({
        requestId: request.requestId,
        claimToken: firstClaim.claimToken,
      });
      const replayedRequest = yield* Queue.take(requests);
      const secondClaim = yield* service.claimCapture({ requestId: replayedRequest.requestId });

      expect(released.released).toBe(true);
      expect(replayedRequest.requestId).toBe(request.requestId);
      expect(secondClaim.claimToken).not.toBeNull();
      if (secondClaim.claimToken === null) {
        return yield* Effect.die(new Error("Expected the replacement renderer claim to succeed."));
      }
      expect(secondClaim.claimToken).not.toBe(firstClaim.claimToken);

      yield* service.completeCapture({
        requestId: request.requestId,
        claimToken: secondClaim.claimToken,
        artifactPath: EnergyDiagnosticsCaptureArtifactPath.make("/tmp/recovered.json"),
        desktopProcessSnapshotCount: 1,
        ipcPressureSnapshotCount: 1,
        ipcChannelCount: 1,
        rendererCommitCount: 1,
        rendererLongTaskCount: 0,
      });
      const completed = yield* Fiber.join(captureFiber);
      expect(completed.status).toBe("completed");
      expect(completed.artifactPath).toBe("/tmp/recovered.json");
    }).pipe(Effect.provide(EnergyCaptureRequests.layer)),
  );

  it.effect("clears pending state when the requesting client is interrupted", () =>
    Effect.gen(function* () {
      const service = yield* EnergyCaptureRequests.EnergyCaptureRequests;
      const requests = yield* collectRequests(service);
      const interruptedFiber = yield* service
        .requestCapture({ durationMs: 1_000, waitTimeoutMs: 16_000 })
        .pipe(Effect.forkScoped);
      yield* Queue.take(requests);
      yield* Fiber.interrupt(interruptedFiber);

      const replacementFiber = yield* service
        .requestCapture({ durationMs: 1_000, waitTimeoutMs: 16_000 })
        .pipe(Effect.forkScoped);
      const replacementRequest = yield* Queue.take(requests);
      const replacementClaim = yield* service.claimCapture({
        requestId: replacementRequest.requestId,
      });
      if (replacementClaim.claimToken === null) {
        return yield* Effect.die(new Error("Expected the replacement capture claim to succeed."));
      }

      yield* service.failCapture({
        requestId: replacementRequest.requestId,
        claimToken: replacementClaim.claimToken,
        message: "Replacement capture completed test cleanup.",
      });
      const replacement = yield* Fiber.join(replacementFiber);
      expect(replacement.status).toBe("failed");
    }).pipe(Effect.provide(EnergyCaptureRequests.layer)),
  );

  it.effect("rejects an explicit timeout shorter than the capture duration plus slack", () =>
    Effect.gen(function* () {
      const service = yield* EnergyCaptureRequests.EnergyCaptureRequests;

      const result = yield* service.requestCapture({
        durationMs: 1_000,
        waitTimeoutMs: 15_999,
      });

      expect(result.status).toBe("rejected");
      expect(result.message).toBe(
        "Wait timeout must be at least the capture duration plus 15000ms.",
      );
    }).pipe(Effect.provide(EnergyCaptureRequests.layer)),
  );
});
