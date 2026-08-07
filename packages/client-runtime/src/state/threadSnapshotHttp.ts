import type {
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadActivityDetailMode,
  OrchestrationTurnActivitiesSnapshot,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

// Bounded so a pathologically slow endpoint cannot block the (cheaper) socket
// fallback for long. The cached thread renders while this runs, so the wait only
// delays the transition to live data on the first open, not the initial paint.
const DEFAULT_THREAD_SNAPSHOT_TIMEOUT_MS = 6_000;
// Historical payloads can be several MB. Keep this explicit and longer than
// the base snapshot timeout; Effect interruption/timeout cancels the request.
const DEFAULT_TURN_ACTIVITIES_TIMEOUT_MS = 30_000;

/**
 * Load a thread's detail snapshot over HTTP instead of embedding it in the
 * WebSocket subscription's first frame. The response is gzip-compressible by
 * the transport and keeps the (potentially multi-KB) snapshot off the socket.
 */
/**
 * Optional turn window for a snapshot fetch. Only send a window to servers
 * that advertise `threadSnapshotPagination`; older servers reject unknown
 * query parameters.
 */
export interface ThreadSnapshotWindow {
  readonly turnLimit: number;
  readonly beforeCursor?: string;
}

export const fetchEnvironmentThreadSnapshot = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadSnapshot",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly activityDetailMode: OrchestrationThreadActivityDetailMode;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
  readonly window?: ThreadSnapshotWindow;
}) {
  const requestUrl = environmentEndpointUrl(
    input.prepared.httpBaseUrl,
    `/api/orchestration/threads/${input.threadId}`,
  );
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl,
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_THREAD_SNAPSHOT_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.orchestration.threadSnapshot({
        params: { threadId: input.threadId },
        payload: {
          activityDetailMode: input.activityDetailMode,
          ...(input.window !== undefined ? { turnLimit: input.window.turnLimit } : {}),
          ...(input.window?.beforeCursor !== undefined
            ? { beforeCursor: input.window.beforeCursor }
            : {}),
        },
        headers,
      }),
    ),
  );
});

export type FetchEnvironmentThreadSnapshotError = RemoteEnvironmentRequestError;

export const fetchEnvironmentTurnActivities = Effect.fn(
  "clientRuntime.state.fetchEnvironmentTurnActivities",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = environmentEndpointUrl(
    input.prepared.httpBaseUrl,
    `/api/orchestration/threads/${input.threadId}/turns/${input.turnId}/activities`,
  );
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl,
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_TURN_ACTIVITIES_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.orchestration.turnActivities({
        params: { threadId: input.threadId, turnId: input.turnId },
        headers,
      }),
    ),
  );
});

export type FetchEnvironmentTurnActivitiesError = RemoteEnvironmentRequestError;

export type ThreadSnapshotLoadOutcome =
  | { readonly _tag: "Found"; readonly snapshot: OrchestrationThreadDetailSnapshot }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "TransientFailure"; readonly message: string };

/**
 * Loads a thread detail snapshot over HTTP with explicit not-found and
 * transient-failure outcomes. This lets cold startup fall back to the socket
 * while authoritative compact refreshes distinguish deletion from retryable
 * transport failure.
 */
export class ThreadSnapshotLoader extends Context.Service<
  ThreadSnapshotLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      threadId: ThreadId,
      activityDetailMode: OrchestrationThreadActivityDetailMode,
      window?: ThreadSnapshotWindow,
    ) => Effect.Effect<ThreadSnapshotLoadOutcome>;
    readonly loadTurnActivities: (
      prepared: PreparedConnection,
      threadId: ThreadId,
      turnId: TurnId,
    ) => Effect.Effect<OrchestrationTurnActivitiesSnapshot, FetchEnvironmentTurnActivitiesError>;
  }
>()("@t3tools/client-runtime/state/threadSnapshotHttp/ThreadSnapshotLoader") {}

export const threadSnapshotLoaderLayer: Layer.Layer<
  ThreadSnapshotLoader,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  ThreadSnapshotLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    // Resolve the DPoP signer optionally: it is only needed for relay/DPoP
    // connections, so the loader must not hard-require it (bearer/primary
    // connections work without one).
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    return ThreadSnapshotLoader.of({
      loadTurnActivities: (prepared, threadId, turnId) =>
        fetchEnvironmentTurnActivities({ prepared, threadId, turnId, signer }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
      load: (prepared, threadId, activityDetailMode, window) =>
        fetchEnvironmentThreadSnapshot({
          prepared,
          threadId,
          activityDetailMode,
          signer,
          ...(window !== undefined ? { window } : {}),
        }).pipe(
          Effect.map((snapshot): ThreadSnapshotLoadOutcome => ({ _tag: "Found", snapshot })),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          // A genuinely missing thread (404) is expected — the socket
          // subscription is the source of truth for thread existence and will
          // surface the deletion — so don't treat it as an error worth warning
          // about; just defer to the socket path.
          Effect.catchTags({
            EnvironmentResourceNotFoundError: () =>
              Effect.logDebug("Thread snapshot not found over HTTP.").pipe(
                Effect.annotateLogs({ threadId }),
                Effect.as<ThreadSnapshotLoadOutcome>({ _tag: "NotFound" }),
              ),
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not load the thread snapshot over HTTP.").pipe(
              Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
              Effect.as<ThreadSnapshotLoadOutcome>({
                _tag: "TransientFailure",
                message: Cause.pretty(cause),
              }),
            ),
          ),
        ),
    });
  }),
);
