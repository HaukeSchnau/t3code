import { useEffect, useRef } from "react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnergyDiagnosticsCaptureClaimToken,
  EnergyDiagnosticsCaptureCompletionInput,
  EnergyDiagnosticsCaptureFailureInput,
  EnergyDiagnosticsCaptureRequest,
} from "@t3tools/contracts";
import { EnergyDiagnosticsCaptureArtifactPath } from "@t3tools/contracts";

import { toastManager } from "../components/ui/toast";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import {
  recordEnergyDiagnosticsCapture,
  type EnergyDiagnosticsServerSnapshot,
} from "./energyDiagnosticsCapture";

const RESOURCE_HISTORY_WINDOW_MS = 15 * 60_000;
const RESOURCE_HISTORY_BUCKET_MS = 30_000;
const COMMAND_RETRY_DELAYS_MS = [0, 250, 750] as const;

function failureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Energy diagnostics capture failed.";
}

async function unwrapCommandResult<A>(
  result: Promise<
    | { readonly _tag: "Success"; readonly value: A }
    | { readonly _tag: "Failure"; readonly cause: unknown }
  >,
): Promise<A> {
  const settled = await result;
  if (settled._tag === "Success") {
    return settled.value;
  }
  throw squashAtomCommandFailure(settled as Parameters<typeof squashAtomCommandFailure>[0]);
}

async function retryCommand<A>(operation: () => Promise<A>, attempt = 0): Promise<A> {
  try {
    return await operation();
  } catch (error) {
    const nextAttempt = attempt + 1;
    if (nextAttempt >= COMMAND_RETRY_DELAYS_MS.length) throw error;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, COMMAND_RETRY_DELAYS_MS[nextAttempt]);
    });
    return retryCommand(operation, nextAttempt);
  }
}

async function executeCaptureRequest(input: {
  readonly request: EnergyDiagnosticsCaptureRequest;
  readonly claimToken: EnergyDiagnosticsCaptureClaimToken;
  readonly readServerSnapshot: () => Promise<EnergyDiagnosticsServerSnapshot>;
  readonly reportComplete: (completion: EnergyDiagnosticsCaptureCompletionInput) => Promise<void>;
  readonly reportFailure: (failure: EnergyDiagnosticsCaptureFailureInput) => Promise<void>;
}): Promise<void> {
  let result: Awaited<ReturnType<typeof recordEnergyDiagnosticsCapture>>;
  let artifactPath: string;
  try {
    result = await recordEnergyDiagnosticsCapture({
      durationMs: input.request.durationMs,
      bridge: typeof window === "undefined" ? undefined : window.desktopBridge,
      readServerSnapshot: input.readServerSnapshot,
      refreshServerDiagnostics: () => undefined,
    });
    if (result.artifactPath === null) {
      throw new Error("The desktop diagnostics artifact writer is unavailable.");
    }
    artifactPath = result.artifactPath;
  } catch (error) {
    const message = failureMessage(error);
    toastManager.add({
      type: "error",
      title: "Energy capture failed",
      description: message,
    });
    await retryCommand(() =>
      input.reportFailure({
        requestId: input.request.requestId,
        claimToken: input.claimToken,
        message,
      }),
    );
    return;
  }

  await retryCommand(() =>
    input.reportComplete({
      requestId: input.request.requestId,
      claimToken: input.claimToken,
      artifactPath: EnergyDiagnosticsCaptureArtifactPath.make(artifactPath),
      desktopProcessSnapshotCount: result.artifact.desktop.processSnapshots.length,
      ipcPressureSnapshotCount: result.artifact.desktop.ipcPressureSnapshots.length,
      ipcChannelCount: result.artifact.desktop.ipcPressureSnapshots.reduce(
        (max, snapshot) => Math.max(max, snapshot.counters.length),
        0,
      ),
      rendererCommitCount: result.artifact.renderer.commits.length,
      rendererLongTaskCount: result.artifact.renderer.longTasks.length,
    }),
  );
}

async function claimAndExecuteCaptureRequest(input: {
  readonly request: EnergyDiagnosticsCaptureRequest;
  readonly claim: () => Promise<EnergyDiagnosticsCaptureClaimToken | null>;
  readonly release: (claimToken: EnergyDiagnosticsCaptureClaimToken) => Promise<void>;
  readonly beforeRelease: () => void;
  readonly readServerSnapshot: () => Promise<EnergyDiagnosticsServerSnapshot>;
  readonly reportComplete: (completion: EnergyDiagnosticsCaptureCompletionInput) => Promise<void>;
  readonly reportFailure: (failure: EnergyDiagnosticsCaptureFailureInput) => Promise<void>;
}): Promise<boolean> {
  const claimToken = await retryCommand(input.claim);
  if (claimToken === null) return false;
  try {
    await executeCaptureRequest({ ...input, claimToken });
  } catch (error) {
    input.beforeRelease();
    try {
      await retryCommand(() => input.release(claimToken));
    } catch (releaseError) {
      console.error("Failed to release energy diagnostics capture claim", releaseError);
    }
    throw error;
  }
  return true;
}

export function EnergyDiagnosticsCaptureRequestConsumer() {
  const environmentId = usePrimaryEnvironmentId();
  const target = environmentId === null ? null : { environmentId, input: {} };
  const { data: request } = useEnvironmentQuery(
    target === null ? null : serverEnvironment.energyDiagnosticsCaptureRequests(target),
  );
  const readTraceDiagnostics = useAtomCommand(serverEnvironment.readTraceDiagnostics, {
    reportFailure: false,
  });
  const readProcessDiagnostics = useAtomCommand(serverEnvironment.readProcessDiagnostics, {
    reportFailure: false,
  });
  const readProcessResourceHistory = useAtomCommand(serverEnvironment.readProcessResourceHistory, {
    reportFailure: false,
  });
  const completeCapture = useAtomCommand(serverEnvironment.completeEnergyDiagnosticsCapture, {
    reportFailure: false,
  });
  const failCapture = useAtomCommand(serverEnvironment.failEnergyDiagnosticsCapture, {
    reportFailure: false,
  });
  const claimCapture = useAtomCommand(serverEnvironment.claimEnergyDiagnosticsCapture, {
    reportFailure: false,
  });
  const releaseCapture = useAtomCommand(serverEnvironment.releaseEnergyDiagnosticsCapture, {
    reportFailure: false,
  });
  const processedRequestIdsRef = useRef(new Set<string>());
  const activeRequestIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (environmentId === null || request === null) return;
    const requestId = request.requestId;
    if (activeRequestIdRef.current !== null || processedRequestIdsRef.current.has(requestId)) {
      return;
    }

    processedRequestIdsRef.current.add(requestId);
    activeRequestIdRef.current = requestId;
    const readServerSnapshot = async (): Promise<EnergyDiagnosticsServerSnapshot> => {
      const [traceDiagnostics, processDiagnostics, processResourceHistory] = await Promise.all([
        unwrapCommandResult(readTraceDiagnostics({ environmentId, input: {} })),
        unwrapCommandResult(readProcessDiagnostics({ environmentId, input: {} })),
        unwrapCommandResult(
          readProcessResourceHistory({
            environmentId,
            input: {
              windowMs: RESOURCE_HISTORY_WINDOW_MS,
              bucketMs: RESOURCE_HISTORY_BUCKET_MS,
            },
          }),
        ),
      ]);
      return {
        traceDiagnostics,
        processDiagnostics,
        processResourceHistory,
      };
    };
    void claimAndExecuteCaptureRequest({
      request,
      claim: async () => {
        const claim = await unwrapCommandResult(
          claimCapture({ environmentId, input: { requestId } }),
        );
        return claim.claimToken;
      },
      release: async (claimToken) => {
        const released = await unwrapCommandResult(
          releaseCapture({ environmentId, input: { requestId, claimToken } }),
        );
        if (!released.released) {
          throw new Error("The diagnostics capture claim is no longer pending.");
        }
      },
      beforeRelease: () => {
        processedRequestIdsRef.current.delete(requestId);
        activeRequestIdRef.current = null;
      },
      readServerSnapshot,
      reportComplete: async (completion) => {
        const completed = await unwrapCommandResult(
          completeCapture({
            environmentId,
            input: completion,
          }),
        );
        if (completed.status !== "completed") {
          throw new Error(completed.message ?? "The diagnostics completion was rejected.");
        }
      },
      reportFailure: async (failure) => {
        const failed = await unwrapCommandResult(
          failCapture({
            environmentId,
            input: failure,
          }),
        );
        if (failed.status !== "failed") {
          throw new Error(failed.message ?? "The diagnostics failure report was rejected.");
        }
      },
    }).then(
      (claimed) => {
        if (!claimed) {
          processedRequestIdsRef.current.delete(requestId);
        }
        activeRequestIdRef.current = null;
      },
      (error: unknown) => {
        processedRequestIdsRef.current.delete(requestId);
        console.error("Energy diagnostics capture request did not settle", error);
        activeRequestIdRef.current = null;
      },
    );
  }, [
    claimCapture,
    completeCapture,
    environmentId,
    failCapture,
    readProcessDiagnostics,
    readProcessResourceHistory,
    readTraceDiagnostics,
    releaseCapture,
    request,
  ]);

  return null;
}
