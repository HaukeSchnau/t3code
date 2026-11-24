/**
 * `t3_thread_launch` with `environmentId: "auto"`: placement picks this
 * environment or a linked peer, and the launch runs there as the same tool call.
 */
import {
  type ModelSelection,
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
import { readCaller } from "../mcp/threadAccess.ts";
import * as LocalPlacement from "./LocalPlacement.ts";
import type * as Placement from "./Placement.ts";

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
  const choice = yield* placement
    .decide(
      {
        projectId,
        instanceId: params.modelSelection?.instanceId ?? caller?.modelSelection.instanceId,
        workspaceStrategy: params.workspaceStrategy ?? { type: "root" },
        hasAttachments: (params.attachments?.length ?? 0) > 0,
        hasContext: false,
      },
      params.clientRequestId === undefined
        ? undefined
        : `mcp:${scope.requestNamespace}\n${params.clientRequestId}`,
    )
    .pipe(Effect.mapError((error) => unavailable(error.message)));
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
    Effect.tapError(() => placement.abandon(choice)),
  );
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
      limits,
    )
    .pipe(Effect.mapError((error) => unavailable(error.message)));
  return yield* decodeResult(launched.result);
});
