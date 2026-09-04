import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  AuthAccessTokenResult,
  AuthBrowserSessionRequest,
  AuthBrowserSessionResult,
  AuthClientSession,
  AuthCreatePairingCredentialInput,
  AuthPairingCredentialResult,
  AuthPairingLink,
  AuthRevokeClientSessionInput,
  AuthRevokePairingLinkInput,
  AuthEnvironmentScope,
  AuthTokenExchangeRequest,
  AuthSessionState,
  AuthWebSocketTicketResult,
  ServerAuthSessionMethod,
} from "./auth.ts";
import {
  DpopFailureReason,
  AuthSessionId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import {
  EnergyDiagnosticsCaptureRequestInput,
  EnergyDiagnosticsCaptureResult,
  WorkloadDiagnosticsSnapshot,
} from "./diagnostics.ts";
import {
  ClientOrchestrationCommand,
  DispatchResult,
  OrchestrationReadModel,
  OrchestrationEffortShell,
  OrchestrationShellSnapshot,
  OrchestrationThreadActivityDetailMode,
  OrchestrationThreadDetailSnapshot,
  OrchestrationTurnActivitiesSnapshot,
  OrchestrationWaitShell,
  OrchestrationWatchShell,
} from "./orchestration.ts";
import {
  ThreadOrchestrationBatch,
  ThreadOrchestrationCleanupBatchResult,
  ThreadOrchestrationCreateBatchResult,
  ThreadOrchestrationCreateThreadResult,
  ThreadOrchestrationError,
  ThreadOrchestrationForkThreadResult,
  ThreadOrchestrationListProjectsResult,
  ThreadOrchestrationListThreadModelsResult,
  ThreadOrchestrationListThreadsResult,
  ThreadOrchestrationListEffortsResult,
  ThreadOrchestrationListWaitsResult,
  ThreadOrchestrationListWatchesResult,
  ThreadOrchestrationScopedCancelBatchInput,
  ThreadOrchestrationScopedCleanupBatchInput,
  ThreadOrchestrationScopedCreateEffortInput,
  ThreadOrchestrationScopedReadEffortInput,
  ThreadOrchestrationScopedListEffortsInput,
  ThreadOrchestrationScopedRenameEffortInput,
  ThreadOrchestrationScopedCloseEffortInput,
  ThreadOrchestrationScopedReopenEffortInput,
  ThreadOrchestrationScopedAddEffortMemberInput,
  ThreadOrchestrationScopedRemoveEffortMemberInput,
  ThreadOrchestrationScopedCreateWaitInput,
  ThreadOrchestrationScopedReadWaitInput,
  ThreadOrchestrationScopedListWaitsInput,
  ThreadOrchestrationScopedCancelWaitInput,
  ThreadOrchestrationScopedCreateWatchInput,
  ThreadOrchestrationScopedReadWatchInput,
  ThreadOrchestrationScopedListWatchesInput,
  ThreadOrchestrationScopedCancelWatchInput,
  ThreadOrchestrationScopedStopThreadInput,
  ThreadOrchestrationScopedCreateBatchInput,
  ThreadOrchestrationScopedCreateThreadInput,
  ThreadOrchestrationScopedForkThreadInput,
  ThreadOrchestrationScopedListThreadsInput,
  ThreadOrchestrationScopedReadThreadInput,
  ThreadOrchestrationScopedReadBatchInput,
  ThreadOrchestrationScopedReadThreadResultInput,
  ThreadOrchestrationScopedSendMessageInput,
  ThreadOrchestrationScopedSetThreadTitleInput,
  ThreadOrchestrationScopedThreadGraphInput,
  ThreadOrchestrationSendMessageResult,
  ThreadOrchestrationThreadDetail,
  ThreadOrchestrationThreadGraphResult,
  ThreadOrchestrationThreadResult,
  ThreadOrchestrationThreadSummary,
} from "./threadOrchestration.ts";
import {
  PullRequestDiffInput,
  PullRequestDiffResult,
  PullRequestOperationError,
  PullRequestUnavailableError,
} from "./pullRequest.ts";
import {
  RelayCloudEnvironmentHealthRequest,
  RelayCloudMintCredentialRequest,
  RelayEnvironmentConfigRequest,
  RelayEnvironmentHealthResponse,
  RelayEnvironmentLinkProof,
  RelayEnvironmentMintResponse,
  RelayLinkProofRequest,
} from "./relay.ts";
import { ServerIdleStatus } from "./server.ts";

const OptionalBearerHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
  dpop: Schema.optionalKey(Schema.String),
});

const OptionalDpopProofHeaders = Schema.Struct({
  dpop: Schema.optionalKey(Schema.String),
});

export const EnvironmentRequestInvalidReason = Schema.Literals([
  "invalid_scope",
  "scope_not_granted",
  "invalid_command",
]);
export type EnvironmentRequestInvalidReason = typeof EnvironmentRequestInvalidReason.Type;

export const EnvironmentAuthInvalidReason = Schema.Literals([
  "missing_credential",
  "invalid_credential",
]);
export type EnvironmentAuthInvalidReason = typeof EnvironmentAuthInvalidReason.Type;

export const EnvironmentOperationForbiddenReason = Schema.Literals([
  "current_session_revoke_not_allowed",
]);
export type EnvironmentOperationForbiddenReason = typeof EnvironmentOperationForbiddenReason.Type;

export const EnvironmentInternalErrorReason = Schema.Literals([
  "bootstrap_validation_failed",
  "browser_session_issuance_failed",
  "browser_session_cookie_failed",
  "access_token_issuance_failed",
  "websocket_ticket_issuance_failed",
  "pairing_credential_issuance_failed",
  "pairing_links_load_failed",
  "pairing_link_revoke_failed",
  "client_sessions_load_failed",
  "client_session_revoke_failed",
  "orchestration_snapshot_failed",
  "orchestration_thread_snapshot_failed",
  "orchestration_dispatch_failed",
  "internal_error",
]);
export type EnvironmentInternalErrorReason = typeof EnvironmentInternalErrorReason.Type;

export class EnvironmentRequestInvalidError extends Schema.TaggedErrorClass<EnvironmentRequestInvalidError>()(
  "EnvironmentRequestInvalidError",
  {
    code: Schema.Literal("invalid_request"),
    reason: EnvironmentRequestInvalidReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentRequestInvalidError)(this, { status: 400 });
  }

  override get message(): string {
    return `The environment rejected the request (${this.reason}).`;
  }
}

export class EnvironmentAuthInvalidError extends Schema.TaggedErrorClass<EnvironmentAuthInvalidError>()(
  "EnvironmentAuthInvalidError",
  {
    code: Schema.Literal("auth_invalid"),
    reason: EnvironmentAuthInvalidReason,
    // Older servers do not send a DPoP failure category.
    dpopFailureReason: Schema.optionalKey(DpopFailureReason),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentAuthInvalidError)(this, { status: 401 });
  }

  override get message(): string {
    return `The environment rejected this client's credentials (${this.reason}).`;
  }
}

export class EnvironmentScopeRequiredError extends Schema.TaggedErrorClass<EnvironmentScopeRequiredError>()(
  "EnvironmentScopeRequiredError",
  {
    code: Schema.Literal("insufficient_scope"),
    requiredScope: AuthEnvironmentScope,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentScopeRequiredError)(this, { status: 403 });
  }

  override get message(): string {
    return `This request needs the ${this.requiredScope} scope, which this client does not have.`;
  }
}

export class EnvironmentOperationForbiddenError extends Schema.TaggedErrorClass<EnvironmentOperationForbiddenError>()(
  "EnvironmentOperationForbiddenError",
  {
    code: Schema.Literal("operation_forbidden"),
    reason: EnvironmentOperationForbiddenReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentOperationForbiddenError)(this, { status: 403 });
  }

  override get message(): string {
    return `The environment refused this operation (${this.reason}).`;
  }
}

export class EnvironmentInternalError extends Schema.TaggedErrorClass<EnvironmentInternalError>()(
  "EnvironmentInternalError",
  {
    code: Schema.Literal("internal_error"),
    reason: EnvironmentInternalErrorReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 500 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentInternalError)(this, { status: 500 });
  }

  override get message(): string {
    return `The environment failed to answer this request (${this.reason}).`;
  }
}

export const EnvironmentResourceNotFoundReason = Schema.Literals(["thread_not_found"]);
export type EnvironmentResourceNotFoundReason = typeof EnvironmentResourceNotFoundReason.Type;

export class EnvironmentResourceNotFoundError extends Schema.TaggedErrorClass<EnvironmentResourceNotFoundError>()(
  "EnvironmentResourceNotFoundError",
  {
    code: Schema.Literal("not_found"),
    reason: EnvironmentResourceNotFoundReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 404 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentResourceNotFoundError)(this, { status: 404 });
  }

  override get message(): string {
    return `The environment could not find what this request named (${this.reason}).`;
  }
}

export const EnvironmentHttpCommonError = Schema.Union([
  EnvironmentRequestInvalidError,
  EnvironmentAuthInvalidError,
  EnvironmentScopeRequiredError,
  EnvironmentOperationForbiddenError,
  EnvironmentResourceNotFoundError,
  EnvironmentInternalError,
]);
export type EnvironmentHttpCommonError = typeof EnvironmentHttpCommonError.Type;

const EnvironmentAuthenticationErrors = [
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
] as const;

export class EnvironmentHttpBadRequestError extends Schema.TaggedErrorClass<EnvironmentHttpBadRequestError>()(
  "EnvironmentHttpBadRequestError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpBadRequestError)(this, { status: 400 });
  }
}

export class EnvironmentHttpUnauthorizedError extends Schema.TaggedErrorClass<EnvironmentHttpUnauthorizedError>()(
  "EnvironmentHttpUnauthorizedError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 401 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpUnauthorizedError)(this, { status: 401 });
  }
}

export class EnvironmentHttpForbiddenError extends Schema.TaggedErrorClass<EnvironmentHttpForbiddenError>()(
  "EnvironmentHttpForbiddenError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpForbiddenError)(this, { status: 403 });
  }
}

export class EnvironmentHttpInternalServerError extends Schema.TaggedErrorClass<EnvironmentHttpInternalServerError>()(
  "EnvironmentHttpInternalServerError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpInternalServerError)(this, { status: 500 });
  }
}

export class EnvironmentHttpConflictError extends Schema.TaggedErrorClass<EnvironmentHttpConflictError>()(
  "EnvironmentHttpConflictError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpConflictError)(this, { status: 409 });
  }
}

export class EnvironmentCloudEndpointUnavailableError extends Schema.TaggedErrorClass<EnvironmentCloudEndpointUnavailableError>()(
  "EnvironmentCloudEndpointUnavailableError",
  {
    message: Schema.String,
    endpointRuntimeStatus: Schema.Unknown,
  },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentCloudEndpointUnavailableError)(this, {
      status: 503,
    });
  }
}
const EnvironmentSessionCreationErrors = [
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
] as const;
const EnvironmentTokenExchangeErrors = [
  EnvironmentRequestInvalidError,
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
] as const;
const EnvironmentScopedOperationErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;
const EnvironmentPairingCredentialErrors = [
  EnvironmentRequestInvalidError,
  ...EnvironmentScopedOperationErrors,
] as const;
const EnvironmentSessionRevokeErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentOperationForbiddenError,
  EnvironmentInternalError,
] as const;
const EnvironmentOrchestrationSnapshotErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;
const EnvironmentOrchestrationThreadSnapshotErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentResourceNotFoundError,
  EnvironmentInternalError,
] as const;
const EnvironmentOrchestrationDispatchErrors = [
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;
const EnvironmentServerIdleStatusErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;
const EnvironmentThreadOrchestrationReadErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
  ThreadOrchestrationError,
] as const;
const EnvironmentThreadOrchestrationOperateErrors = [
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
  ThreadOrchestrationError,
] as const;

export interface EnvironmentSessionPrincipalShape {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly method: ServerAuthSessionMethod;
  readonly scopes: ReadonlySet<AuthEnvironmentScope>;
  readonly proofKeyThumbprint?: string;
  readonly expiresAt?: DateTime.DateTime;
}

export class EnvironmentAuthenticatedPrincipal extends Context.Service<
  EnvironmentAuthenticatedPrincipal,
  EnvironmentSessionPrincipalShape
>()("@t3tools/contracts/environmentHttp/EnvironmentAuthenticatedPrincipal") {}

export class EnvironmentAuthenticatedAuth extends HttpApiMiddleware.Service<
  EnvironmentAuthenticatedAuth,
  { provides: EnvironmentAuthenticatedPrincipal }
>()("EnvironmentAuthenticatedAuth", {
  error: EnvironmentAuthenticationErrors,
}) {}

const EnvironmentHttpCloudErrors = [
  EnvironmentHttpBadRequestError,
  EnvironmentHttpUnauthorizedError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpConflictError,
  EnvironmentHttpInternalServerError,
  EnvironmentScopeRequiredError,
] as const;

export const EnvironmentCloudRelayConfigResult = Schema.Struct({
  ok: Schema.Boolean,
  endpointRuntimeStatus: Schema.Unknown,
});
export type EnvironmentCloudRelayConfigResult = typeof EnvironmentCloudRelayConfigResult.Type;

export const EnvironmentCloudLinkStateResult = Schema.Struct({
  linked: Schema.Boolean,
  cloudUserId: Schema.NullOr(Schema.String),
  relayUrl: Schema.NullOr(Schema.String),
  relayIssuer: Schema.NullOr(Schema.String),
  // A managed Cloudflare tunnel is provisioned for this link. False for a
  // publish-only link (activity publishing without a relay-managed tunnel), so
  // clients can present the two capabilities as independent settings.
  // Optional so newer clients tolerate older environment servers.
  managedTunnelActive: Schema.optional(Schema.Boolean),
  publishAgentActivity: Schema.Boolean,
});
export type EnvironmentCloudLinkStateResult = typeof EnvironmentCloudLinkStateResult.Type;

export const EnvironmentCloudPreferencesRequest = Schema.Struct({
  publishAgentActivity: Schema.Boolean,
});
export type EnvironmentCloudPreferencesRequest = typeof EnvironmentCloudPreferencesRequest.Type;

export const AuthPairingLinkRevokeResult = Schema.Struct({
  revoked: Schema.Boolean,
});
export type AuthPairingLinkRevokeResult = typeof AuthPairingLinkRevokeResult.Type;

export const AuthClientSessionRevokeResult = Schema.Struct({
  revoked: Schema.Boolean,
});
export type AuthClientSessionRevokeResult = typeof AuthClientSessionRevokeResult.Type;

export const AuthOtherClientSessionsRevokeResult = Schema.Struct({
  revokedCount: Schema.Number,
});
export type AuthOtherClientSessionsRevokeResult = typeof AuthOtherClientSessionsRevokeResult.Type;

export class EnvironmentMetadataHttpApi extends HttpApiGroup.make("metadata").add(
  HttpApiEndpoint.get("descriptor", "/.well-known/t3/environment", {
    success: ExecutionEnvironmentDescriptor,
  }),
) {}

export class EnvironmentAuthHttpApi extends HttpApiGroup.make("auth")
  .add(
    HttpApiEndpoint.get("session", "/api/auth/session", {
      headers: OptionalBearerHeaders,
      success: AuthSessionState,
      error: [EnvironmentInternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("browserSession", "/api/auth/browser-session", {
      payload: AuthBrowserSessionRequest,
      success: AuthBrowserSessionResult,
      error: EnvironmentSessionCreationErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("token", "/oauth/token", {
      headers: OptionalDpopProofHeaders,
      payload: AuthTokenExchangeRequest,
      success: AuthAccessTokenResult,
      error: EnvironmentTokenExchangeErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("webSocketTicket", "/api/auth/websocket-ticket", {
      headers: OptionalBearerHeaders,
      success: AuthWebSocketTicketResult,
      error: [EnvironmentInternalError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("pairingCredential", "/api/auth/pairing-token", {
      headers: OptionalBearerHeaders,
      payload: AuthCreatePairingCredentialInput,
      success: AuthPairingCredentialResult,
      error: EnvironmentPairingCredentialErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("pairingLinks", "/api/auth/pairing-links", {
      headers: OptionalBearerHeaders,
      success: Schema.Array(AuthPairingLink),
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokePairingLink", "/api/auth/pairing-links/revoke", {
      headers: OptionalBearerHeaders,
      payload: AuthRevokePairingLinkInput,
      success: AuthPairingLinkRevokeResult,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("clients", "/api/auth/clients", {
      headers: OptionalBearerHeaders,
      success: Schema.Array(AuthClientSession),
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokeClient", "/api/auth/clients/revoke", {
      headers: OptionalBearerHeaders,
      payload: AuthRevokeClientSessionInput,
      success: AuthClientSessionRevokeResult,
      error: EnvironmentSessionRevokeErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokeOtherClients", "/api/auth/clients/revoke-others", {
      headers: OptionalBearerHeaders,
      success: AuthOtherClientSessionsRevokeResult,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

const EnvironmentOrchestrationThreadSnapshotParams = Schema.Struct({
  threadId: ThreadId,
});

const EnvironmentOrchestrationTurnActivitiesParams = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
});

// Query-string window for windowed thread snapshots (GET payloads must encode
// to strings). Both fields optional: omitting them keeps the full-snapshot
// behavior, so pagination stays opt-in per request.
const EnvironmentOrchestrationThreadSnapshotQuery = {
  activityDetailMode: Schema.optionalKey(OrchestrationThreadActivityDetailMode),
  turnLimit: Schema.optional(
    Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  ),
  beforeCursor: Schema.optional(TrimmedNonEmptyString),
};
export class EnvironmentOrchestrationHttpApi extends HttpApiGroup.make("orchestration")
  .add(
    HttpApiEndpoint.get("snapshot", "/api/orchestration/snapshot", {
      headers: OptionalBearerHeaders,
      success: OrchestrationReadModel,
      error: EnvironmentOrchestrationSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("shellSnapshot", "/api/orchestration/shell", {
      headers: OptionalBearerHeaders,
      success: OrchestrationShellSnapshot,
      error: EnvironmentOrchestrationSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("threadSnapshot", "/api/orchestration/threads/:threadId", {
      headers: OptionalBearerHeaders,
      params: EnvironmentOrchestrationThreadSnapshotParams,
      payload: EnvironmentOrchestrationThreadSnapshotQuery,
      success: OrchestrationThreadDetailSnapshot,
      error: EnvironmentOrchestrationThreadSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get(
      "turnActivities",
      "/api/orchestration/threads/:threadId/turns/:turnId/activities",
      {
        headers: OptionalBearerHeaders,
        params: EnvironmentOrchestrationTurnActivitiesParams,
        success: OrchestrationTurnActivitiesSnapshot,
        error: EnvironmentOrchestrationThreadSnapshotErrors,
      },
    ).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("dispatch", "/api/orchestration/dispatch", {
      headers: OptionalBearerHeaders,
      payload: ClientOrchestrationCommand,
      success: DispatchResult,
      error: EnvironmentOrchestrationDispatchErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

export class EnvironmentServerHttpApi extends HttpApiGroup.make("server")
  .add(
    HttpApiEndpoint.get("idleStatus", "/api/server/idle", {
      headers: OptionalBearerHeaders,
      success: ServerIdleStatus,
      error: EnvironmentServerIdleStatusErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("workloadDiagnostics", "/api/diagnostics/workload", {
      headers: OptionalBearerHeaders,
      success: WorkloadDiagnosticsSnapshot,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("requestEnergyCapture", "/api/diagnostics/energy-capture", {
      headers: OptionalBearerHeaders,
      payload: EnergyDiagnosticsCaptureRequestInput,
      success: EnergyDiagnosticsCaptureResult,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

export class EnvironmentThreadOrchestrationHttpApi extends HttpApiGroup.make("threadOrchestration")
  .add(
    HttpApiEndpoint.get("listProjects", "/api/thread-orchestration/projects", {
      headers: OptionalBearerHeaders,
      success: ThreadOrchestrationListProjectsResult,
      error: EnvironmentThreadOrchestrationReadErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("listThreadModels", "/api/thread-orchestration/thread-models", {
      headers: OptionalBearerHeaders,
      success: ThreadOrchestrationListThreadModelsResult,
      error: EnvironmentThreadOrchestrationReadErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("listAllProjects", "/api/thread-orchestration/all-projects", {
      headers: OptionalBearerHeaders,
      success: ThreadOrchestrationListProjectsResult,
      error: EnvironmentThreadOrchestrationReadErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("listAllThreadModels", "/api/thread-orchestration/all-thread-models", {
      headers: OptionalBearerHeaders,
      success: ThreadOrchestrationListThreadModelsResult,
      error: EnvironmentThreadOrchestrationReadErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("listThreads", "/api/thread-orchestration/list-threads", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedListThreadsInput,
      success: ThreadOrchestrationListThreadsResult,
      error: EnvironmentThreadOrchestrationReadErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("readThread", "/api/thread-orchestration/read-thread", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedReadThreadInput,
      success: ThreadOrchestrationThreadDetail,
      error: EnvironmentThreadOrchestrationOperateErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("readThreadResult", "/api/thread-orchestration/read-thread-result", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedReadThreadResultInput,
      success: ThreadOrchestrationThreadResult,
      error: EnvironmentThreadOrchestrationReadErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("getThreadGraph", "/api/thread-orchestration/graph", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedThreadGraphInput,
      success: ThreadOrchestrationThreadGraphResult,
      error: EnvironmentThreadOrchestrationReadErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("createThread", "/api/thread-orchestration/create-thread", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedCreateThreadInput,
      success: ThreadOrchestrationCreateThreadResult,
      error: EnvironmentThreadOrchestrationOperateErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("createBatch", "/api/thread-orchestration/create-batch", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedCreateBatchInput,
      success: ThreadOrchestrationCreateBatchResult,
      error: EnvironmentThreadOrchestrationOperateErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("readBatch", "/api/thread-orchestration/read-batch", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedReadBatchInput,
      success: ThreadOrchestrationBatch,
      error: EnvironmentThreadOrchestrationReadErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("cancelBatch", "/api/thread-orchestration/cancel-batch", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedCancelBatchInput,
      success: ThreadOrchestrationBatch,
      error: EnvironmentThreadOrchestrationOperateErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("cleanupBatch", "/api/thread-orchestration/cleanup-batch", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedCleanupBatchInput,
      success: ThreadOrchestrationCleanupBatchResult,
      error: EnvironmentThreadOrchestrationOperateErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("createEffort", "/api/thread-orchestration/efforts/create", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedCreateEffortInput,
      success: OrchestrationEffortShell,
      error: EnvironmentThreadOrchestrationOperateErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("readEffort", "/api/thread-orchestration/efforts/read", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedReadEffortInput,
      success: OrchestrationEffortShell,
      error: EnvironmentThreadOrchestrationReadErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("listEfforts", "/api/thread-orchestration/efforts/list", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedListEffortsInput,
      success: ThreadOrchestrationListEffortsResult,
      error: EnvironmentThreadOrchestrationReadErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("renameEffort", "/api/thread-orchestration/efforts/rename", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedRenameEffortInput,
      success: OrchestrationEffortShell,
      error: EnvironmentThreadOrchestrationOperateErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("closeEffort", "/api/thread-orchestration/efforts/close", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedCloseEffortInput,
      success: OrchestrationEffortShell,
      error: EnvironmentThreadOrchestrationOperateErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("reopenEffort", "/api/thread-orchestration/efforts/reopen", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedReopenEffortInput,
      success: OrchestrationEffortShell,
      error: EnvironmentThreadOrchestrationOperateErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("addEffortMember", "/api/thread-orchestration/efforts/add-member", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedAddEffortMemberInput,
      success: OrchestrationEffortShell,
      error: EnvironmentThreadOrchestrationOperateErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("removeEffortMember", "/api/thread-orchestration/efforts/remove-member", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedRemoveEffortMemberInput,
      success: OrchestrationEffortShell,
      error: EnvironmentThreadOrchestrationOperateErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("createWait", "/api/thread-orchestration/waits/create", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedCreateWaitInput,
      success: OrchestrationWaitShell,
      error: EnvironmentThreadOrchestrationOperateErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("readWait", "/api/thread-orchestration/waits/read", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedReadWaitInput,
      success: OrchestrationWaitShell,
      error: EnvironmentThreadOrchestrationReadErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("listWaits", "/api/thread-orchestration/waits/list", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedListWaitsInput,
      success: ThreadOrchestrationListWaitsResult,
      error: EnvironmentThreadOrchestrationReadErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("cancelWait", "/api/thread-orchestration/waits/cancel", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedCancelWaitInput,
      success: OrchestrationWaitShell,
      error: EnvironmentThreadOrchestrationOperateErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("createWatch", "/api/thread-orchestration/watches/create", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedCreateWatchInput,
      success: OrchestrationWatchShell,
      error: EnvironmentThreadOrchestrationOperateErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("readWatch", "/api/thread-orchestration/watches/read", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedReadWatchInput,
      success: OrchestrationWatchShell,
      error: EnvironmentThreadOrchestrationReadErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("listWatches", "/api/thread-orchestration/watches/list", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedListWatchesInput,
      success: ThreadOrchestrationListWatchesResult,
      error: EnvironmentThreadOrchestrationReadErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("cancelWatch", "/api/thread-orchestration/watches/cancel", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedCancelWatchInput,
      success: OrchestrationWatchShell,
      error: EnvironmentThreadOrchestrationOperateErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("stopThread", "/api/thread-orchestration/stop-thread", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedStopThreadInput,
      success: ThreadOrchestrationThreadSummary,
      error: EnvironmentThreadOrchestrationOperateErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("forkThread", "/api/thread-orchestration/fork-thread", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedForkThreadInput,
      success: ThreadOrchestrationForkThreadResult,
      error: EnvironmentThreadOrchestrationOperateErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("sendMessageToThread", "/api/thread-orchestration/send-message", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedSendMessageInput,
      success: ThreadOrchestrationSendMessageResult,
      error: EnvironmentThreadOrchestrationOperateErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("setThreadTitle", "/api/thread-orchestration/set-title", {
      headers: OptionalBearerHeaders,
      payload: ThreadOrchestrationScopedSetThreadTitleInput,
      success: ThreadOrchestrationThreadSummary,
      error: EnvironmentThreadOrchestrationOperateErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

/** Large, compressible pull-request payloads travel over HTTP rather than the RPC socket. */
export class EnvironmentPullRequestsHttpApi extends HttpApiGroup.make("pullRequests").add(
  HttpApiEndpoint.post("diff", "/api/pull-requests/diff", {
    headers: OptionalBearerHeaders,
    payload: PullRequestDiffInput,
    success: PullRequestDiffResult,
    error: [
      PullRequestUnavailableError,
      PullRequestOperationError,
      EnvironmentAuthInvalidError,
      EnvironmentScopeRequiredError,
      EnvironmentInternalError,
    ],
  }).middleware(EnvironmentAuthenticatedAuth),
) {}

export class EnvironmentConnectHttpApi extends HttpApiGroup.make("connect")
  .add(
    HttpApiEndpoint.post("linkProof", "/api/connect/link-proof", {
      headers: OptionalBearerHeaders,
      payload: RelayLinkProofRequest,
      success: RelayEnvironmentLinkProof,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("relayConfig", "/api/connect/relay-config", {
      headers: OptionalBearerHeaders,
      payload: RelayEnvironmentConfigRequest,
      success: EnvironmentCloudRelayConfigResult,
      error: [...EnvironmentHttpCloudErrors, EnvironmentCloudEndpointUnavailableError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("linkState", "/api/connect/link-state", {
      headers: OptionalBearerHeaders,
      success: EnvironmentCloudLinkStateResult,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("unlink", "/api/connect/unlink", {
      headers: OptionalBearerHeaders,
      success: EnvironmentCloudRelayConfigResult,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("preferences", "/api/connect/preferences", {
      headers: OptionalBearerHeaders,
      payload: EnvironmentCloudPreferencesRequest,
      success: EnvironmentCloudLinkStateResult,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("health", "/api/t3-connect/health", {
      payload: RelayCloudEnvironmentHealthRequest,
      success: RelayEnvironmentHealthResponse,
      error: EnvironmentHttpCloudErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("mintCredential", "/api/connect/mint-credential", {
      payload: RelayCloudMintCredentialRequest,
      success: RelayEnvironmentMintResponse,
      error: EnvironmentHttpCloudErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("t3MintCredential", "/api/t3-connect/mint-credential", {
      payload: RelayCloudMintCredentialRequest,
      success: RelayEnvironmentMintResponse,
      error: EnvironmentHttpCloudErrors,
    }),
  ) {}

export class EnvironmentHttpApi extends HttpApi.make("environment")
  .add(EnvironmentMetadataHttpApi)
  .add(EnvironmentAuthHttpApi)
  .add(EnvironmentOrchestrationHttpApi)
  .add(EnvironmentServerHttpApi)
  .add(EnvironmentThreadOrchestrationHttpApi)
  .add(EnvironmentPullRequestsHttpApi)
  .add(EnvironmentConnectHttpApi) {}
