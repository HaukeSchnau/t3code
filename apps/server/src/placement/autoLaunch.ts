/**
 * `t3_thread_launch` with `environmentId: "auto"`: placement picks this
 * environment or a linked peer, and the launch runs there as the same tool call.
 */
import {
  type ModelSelection,
  PlacementError,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";

import { assertNotLinked } from "../mcp/linkOrigin.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { readCaller } from "../mcp/threadAccess.ts";
import * as LocalPlacement from "./LocalPlacement.ts";
import * as Placement from "./Placement.ts";

/** The `t3_thread_launch` parameters placement reads; the rest pass through unchanged. */
interface LaunchParams {
  readonly projectId?: ProjectId | undefined;
  readonly scratch?: boolean | undefined;
  readonly title: string;
  readonly modelSelection?: ModelSelection | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly interactionMode?: ProviderInteractionMode | undefined;
  readonly workspaceStrategy?: OrchestrationV2ThreadLaunchWorkspaceStrategy | undefined;
  readonly message?: string | undefined;
  readonly attachments?: ReadonlyArray<unknown> | undefined;
  readonly clientRequestId?: string | undefined;
}

const unavailable = (message: string) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message });

export const autoLaunch = Effect.fn("Placement.autoLaunch")(function* <A, E, R, E2, R2>(
  placement: Placement.Placement["Service"],
  params: LaunchParams,
  here: (params: LaunchParams) => Effect.Effect<A, E, R>,
  /** The caller's checks for acting on another environment, run once a peer is chosen. */
  beforePeer: Effect.Effect<unknown, E2, R2>,
  decodeResult: (result: unknown) => Effect.Effect<A, OrchestratorMcpFailure>,
) {
  const context = yield* readCaller();
  const { caller, limits, scope } = context;
  const callerContext = yield* Effect.context<
    McpInvocationContext.McpInvocationContext | ThreadManagement.ThreadManagementService
  >();
  // The turn that asked; once it stops, nothing more goes out for it.
  const invokingRun = caller?.activeRunId ?? null;
  const stillAsking = (now: Effect.Success<ReturnType<typeof readCaller>>) =>
    now.caller === undefined ? Effect.succeed(true) : placement.runIsLive(invokingRun);
  if (
    params.scratch === true &&
    (params.projectId !== undefined || params.workspaceStrategy !== undefined)
  ) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        "scratch:true picks its own project and folder; omit projectId and workspaceStrategy.",
    });
  }
  const projectId = params.scratch === true ? null : (params.projectId ?? caller?.projectId);
  if (projectId === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: 'environmentId "auto" outside a thread needs projectId or scratch:true.',
    });
  }
  const mayClone = Placement.limitsMayClone({
    runtimeMode: params.runtimeMode ?? limits.runtimeMode,
    interactionMode: params.interactionMode ?? limits.interactionMode,
  });
  const choice = yield* placement
    .decide(
      {
        projectId,
        instanceId: params.modelSelection?.instanceId ?? caller?.modelSelection.instanceId,
        workspaceStrategy: params.workspaceStrategy ?? { type: "root" },
        hasAttachments: (params.attachments?.length ?? 0) > 0,
        hasContext: false,
        mayClone,
      },
      params.clientRequestId === undefined
        ? undefined
        : `mcp:${scope.requestNamespace}\n${params.clientRequestId}`,
    )
    .pipe(Effect.mapError((error) => unavailable(error.message)));
  // A retry reuses its first decision, which may be a clone these modes may not start. The
  // reservation stays with the attempt that may clone, which may still be running.
  if (choice._tag === "Peer" && "clone" in choice.target && !mayClone) {
    return yield* unavailable("Starting it there needs a clone these modes may not make.");
  }
  if (choice._tag === "Here") {
    return yield* here(params).pipe(
      Effect.provideService(
        LocalPlacement.PlacementStamp,
        choice.placement === undefined ? undefined : { placement: choice.placement },
      ),
    );
  }
  // Work a fenced link started never uses this environment's links (PeerForwarding).
  // A launch refused before it is sent does not count against the peer.
  yield* assertNotLinked(context, "use this environment's links").pipe(
    Effect.andThen(beforePeer),
    // A clone there first, authorized by the caller's modes as they are when files would leave.
    Effect.andThen(
      placement
        .prepareTarget(
          choice,
          readCaller().pipe(
            Effect.mapError((error) => new PlacementError({ message: error.message })),
            Effect.flatMap((now) =>
              stillAsking(now).pipe(
                Effect.flatMap((live) =>
                  live
                    ? Effect.succeed(now.limits)
                    : Effect.fail(new PlacementError({ message: "The calling thread stopped." })),
                ),
              ),
            ),
            Effect.provideContext(callerContext),
          ),
        )
        .pipe(Effect.mapError((error) => unavailable(error.message))),
    ),
    Effect.tapError(() => placement.abandon(choice)),
  );
  // Read again: the calling thread's modes may have changed, or it stopped, while placement
  // probed or cloned.
  const now = yield* readCaller();
  if (!(yield* stillAsking(now))) {
    yield* placement.abandon(choice);
    return yield* unavailable("The calling thread stopped.");
  }
  const current = now.limits;
  // Every caller here reaches the peer as one link session, so the retry key names its caller.
  const clientRequestId =
    params.clientRequestId === undefined
      ? undefined
      : `fwd:${Hex.encode(
          yield* Digest.Digest.pipe(
            Effect.flatMap((crypto) =>
              crypto.digest(
                Digest.sha256,
                new TextEncoder().encode(`${scope.requestNamespace}\n${params.clientRequestId}`),
              ),
            ),
            Effect.orDie,
          ),
        )}`;
  const modelSelection = params.modelSelection ?? caller?.modelSelection;
  const launched = yield* placement
    .launchOnPeer(
      choice,
      {
        title: params.title,
        ...(modelSelection === undefined ? {} : { modelSelection }),
        // Omitted modes stay omitted, so the peer applies the project's defaults under `limits`.
        ...(params.runtimeMode === undefined ? {} : { runtimeMode: params.runtimeMode }),
        ...(params.interactionMode === undefined
          ? {}
          : { interactionMode: params.interactionMode }),
        ...(params.workspaceStrategy === undefined || "scratch" in choice.target
          ? {}
          : { workspaceStrategy: params.workspaceStrategy }),
        ...(params.message === undefined ? {} : { message: params.message }),
        ...(clientRequestId === undefined ? {} : { clientRequestId }),
      },
      current,
      undefined,
      undefined,
      // The asking run and its modes once more, after the peer's link resolved.
      readCaller().pipe(
        Effect.mapError((error) => new PlacementError({ message: error.message })),
        Effect.flatMap((latest) =>
          stillAsking(latest).pipe(
            Effect.flatMap((live) =>
              live &&
              latest.limits.runtimeMode === current.runtimeMode &&
              latest.limits.interactionMode === current.interactionMode
                ? Effect.void
                : Effect.fail(
                    new PlacementError({
                      message: "The calling thread stopped or changed its modes; nothing started.",
                    }),
                  ),
            ),
          ),
        ),
        Effect.provideContext(callerContext),
      ),
    )
    .pipe(Effect.mapError((error) => unavailable(error.message)));
  return yield* decodeResult(launched.result);
});
