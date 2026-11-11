import {
  ProviderDriverKind,
  UsageLimitSourceError,
  type ProviderConsumeResetCreditResult,
  type UsageLimitSourceAccount,
  type UsageLimitSourceConfig,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  GROK_USAGE_URL,
  GrokUsageResponse,
  grokUsageResponseToLimits,
} from "@t3tools/provider-grok/server";
import { codexPlanLabel } from "../provider/CodexProvider.ts";
import {
  CODEX_USAGE_BASE,
  CodexUsage,
  codexBackendHeaders,
  codexUsageToLimits,
} from "../provider/codexUsageLimits.ts";
import { CLAUDE_USAGE_URL } from "../provider/claudeResetCredits.ts";
import { ClaudeOauthUsage, claudeOauthUsageToLimits } from "../provider/claudeUsageLimits.ts";
import {
  antigravityAccountFingerprint,
  antigravitySummaryWindows,
  antigravityUserAgent,
} from "../provider/antigravityUsageLimits.ts";
import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
  UsageLimitsReadError,
  usageLimitsReadFailure,
  usageLimitsStatusError,
} from "@t3tools/provider-core/server/usageLimits";

/** A hub with its management key already read from wherever the setting keeps it. */
export interface CliproxyHub {
  readonly url: UsageLimitSourceConfig["url"];
  readonly managementKey: string;
}

const AuthFile = Schema.Struct({
  id: Schema.String,
  auth_index: Schema.String,
  provider: Schema.String,
  email: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
  modtime: Schema.optional(Schema.String),
  project_id: Schema.optional(Schema.String),
  id_token: Schema.optional(
    Schema.Struct({
      chatgpt_account_id: Schema.optional(Schema.String),
      chatgpt_plan_type: Schema.optional(Schema.String),
      plan_type: Schema.optional(Schema.String),
    }),
  ),
});
const AuthFiles = Schema.Struct({ files: Schema.Array(AuthFile) });
// Go's `map[string][]string`, so `null` when the provider sent no headers.
const ApiResponse = Schema.Struct({
  status_code: Schema.Number,
  header: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Array(Schema.String)))),
  body: Schema.String,
});
const CreditList = Schema.Struct({
  credits: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      reset_type: Schema.String,
      expires_at: Schema.String,
    }),
  ),
});

const decodeAuthFiles = Schema.decodeUnknownEffect(AuthFiles);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeApiResponse = Schema.decodeUnknownEffect(ApiResponse);
const decodeCreditList = Schema.decodeUnknownEffect(Schema.fromJsonString(CreditList));
const decodeClaudeUsage = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeOauthUsage));
const decodeCodexUsage = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexUsage));
const decodeGrokUsage = Schema.decodeUnknownEffect(Schema.fromJsonString(GrokUsageResponse));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const isUsageLimitsReadError = Schema.is(UsageLimitsReadError);
const isUsageLimitSourceError = Schema.is(UsageLimitSourceError);

// Extra CAs can fix untrusted chains; expiry/hostname failures report codes only.
const UNTRUSTED_CERTIFICATE_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

// fetch wraps Node error codes in generic TypeErrors.
const nodeErrorCode = (cause: unknown) => {
  for (let error = cause, depth = 0; error instanceof Error && depth < 3; depth += 1) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
    error = error.cause;
  }
  return undefined;
};

// Hub responses can contain credentials; expose only failure kind, HTTP status or Node code.
const describeManagementFailure = (error: unknown) => {
  if (Cause.isTimeoutError(error)) return "The hub did not answer within 15 seconds.";
  if (HttpClientError.isHttpClientError(error)) {
    const reason = error.reason;
    if (reason._tag === "StatusCodeError") {
      return `The hub answered with HTTP ${reason.response.status}.`;
    }
    const code = reason._tag === "TransportError" ? nodeErrorCode(reason.cause) : undefined;
    if (code !== undefined && UNTRUSTED_CERTIFICATE_CODES.has(code)) {
      return `The hub's TLS certificate is not trusted (${code}). If it comes from a private CA, add that CA to NODE_EXTRA_CA_CERTS.`;
    }
    if (code !== undefined) return `The hub request failed (${code}).`;
  }
  return "The hub management request failed.";
};
const decodeConsumeResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      code: Schema.Literals(["reset", "nothing_to_reset", "no_credit", "already_redeemed"]),
    }),
  ),
);

const CREDIT_URL = `${CODEX_USAGE_BASE}/rate-limit-reset-credits`;

const CREDIT_REDEEM_NAMESPACE = new Uint8Array([
  0x6f, 0x1c, 0x2a, 0x9e, 0x2d, 0x4b, 0x4c, 0x1e, 0x9a, 0x7f, 0x3b, 0x8d, 0x5e, 0x0c, 0x1a, 0x42,
]);

// UUIDv5 per account and credit also deduplicates retries across T3 environments.
const creditRedeemRequestId = Effect.fn("CliproxyApi.creditRedeemRequestId")(function* (
  accountId: string,
  creditId: string,
) {
  const digest = yield* Digest.Digest;
  const name = new TextEncoder().encode(`${accountId}:${creditId}`);
  const input = new Uint8Array(CREDIT_REDEEM_NAMESPACE.length + name.length);
  input.set(CREDIT_REDEEM_NAMESPACE);
  input.set(name, CREDIT_REDEEM_NAMESPACE.length);
  const bytes = (yield* digest.digest(Digest.sha1, input).pipe(Effect.orDie)).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Hex.encode(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
});

type AuthFile = typeof AuthFile.Type;
/** Sends one upstream request with the account's token, as GET or as a JSON POST of `data`. */
type HubCall = (
  url: string,
  data?: unknown,
) => Effect.Effect<string, UsageLimitSourceError | UsageLimitsReadError | Schema.SchemaError>;
type HubReading = Omit<UsageLimitSourceAccount, "id" | "driver">;
interface HubProvider {
  readonly driver: ProviderDriverKind;
  /** Names the provider in errors about its usage reads. */
  readonly label: string;
  readonly header: (
    account: AuthFile,
    platform: NodeJS.Platform,
    architecture: NodeJS.Architecture,
  ) => Record<string, string>;
  readonly read: (input: {
    readonly account: AuthFile;
    readonly call: HubCall;
    readonly checkedAt: string;
  }) => Effect.Effect<
    HubReading,
    UsageLimitSourceError | UsageLimitsReadError | Schema.SchemaError,
    Digest.Digest
  >;
}

const listedIdentity = (account: AuthFile) => ({
  ...(account.email ? { email: account.email } : {}),
  ...(account.id_token?.chatgpt_account_id?.trim()
    ? { workspaceId: account.id_token.chatgpt_account_id.trim() }
    : {}),
});

const credits = Effect.fn("CliproxyApi.credits")(function* (call: HubCall) {
  const response = yield* decodeCreditList(yield* call(CREDIT_URL));
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  return response.credits
    .filter(
      (credit) =>
        credit.reset_type === "codex_rate_limits" &&
        credit.status === "available" &&
        Date.parse(credit.expires_at) > now,
    )
    .toSorted((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at));
});

const CODEX_HUB: HubProvider = {
  driver: ProviderDriverKind.make("codex"),
  label: "Codex",
  header: (account) => ({
    Authorization: "Bearer $TOKEN$",
    ...codexBackendHeaders(account.id_token?.chatgpt_account_id),
  }),
  read: Effect.fnUntraced(function* ({ account, call, checkedAt }) {
    const usage = yield* decodeCodexUsage(yield* call(`${CODEX_USAGE_BASE}/usage`));
    const available = yield* credits(call).pipe(Effect.orElseSucceed(() => undefined));
    const next = available?.[0];
    const planType =
      usage.plan_type ?? account.id_token?.plan_type ?? account.id_token?.chatgpt_plan_type;
    return {
      ...listedIdentity(account),
      plan: codexPlanLabel(planType),
      usageLimits: {
        ...codexUsageToLimits(usage, checkedAt, planType),
        ...(available
          ? {
              resetCredits: {
                availableCount: available.length,
                ...(next
                  ? {
                      nextCreditId: next.id,
                      nextExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(next.expires_at)),
                    }
                  : {}),
              },
            }
          : {}),
      },
    };
  }),
};

const GROK_CLI_VERSION = "1.0.77";
const ANTIGRAVITY_SUMMARY_URL =
  "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";

// Keyed by the auth-files `provider`; accounts of any other provider are skipped.
const HUB_PROVIDERS = new Map<string, HubProvider>([
  ["codex", CODEX_HUB],
  [
    "claude",
    {
      driver: ProviderDriverKind.make("claudeAgent"),
      label: "Claude",
      header: () => ({
        Authorization: "Bearer $TOKEN$",
        "anthropic-beta": "oauth-2025-04-20",
        // The OAuth usage endpoint can return 429 without a Claude Code user agent.
        "User-Agent": "claude-code/2.1.273",
      }),
      read: Effect.fnUntraced(function* ({ account, call, checkedAt }) {
        const usage = yield* decodeClaudeUsage(yield* call(CLAUDE_USAGE_URL));
        return {
          ...listedIdentity(account),
          plan: "Claude Subscription",
          usageLimits: claudeOauthUsageToLimits(usage, checkedAt).limits,
        };
      }),
    },
  ],
  [
    "xai",
    {
      driver: ProviderDriverKind.make("grok"),
      label: "Grok",
      header: () => ({
        Authorization: "Bearer $TOKEN$",
        "x-xai-token-auth": "xai-grok-cli",
        "x-grok-client-version": GROK_CLI_VERSION,
        "User-Agent": `grok-cli/${GROK_CLI_VERSION}`,
      }),
      read: Effect.fnUntraced(function* ({ account, call, checkedAt }) {
        const usage = yield* decodeGrokUsage(yield* call(GROK_USAGE_URL));
        return {
          ...listedIdentity(account),
          usageLimits: grokUsageResponseToLimits(usage, checkedAt),
        };
      }),
    },
  ],
  [
    "antigravity",
    {
      driver: ProviderDriverKind.make("antigravity"),
      label: "Antigravity",
      header: (_account, platform, architecture) => ({
        Authorization: "Bearer $TOKEN$",
        "Content-Type": "application/json",
        "User-Agent": antigravityUserAgent(platform, architecture),
      }),
      read: Effect.fnUntraced(function* ({ account, call, checkedAt }) {
        const project = account.project_id?.trim();
        if (!project) {
          return yield* new UsageLimitSourceError({ detail: "No Antigravity project reported." });
        }
        const requestedAt = DateTime.toEpochMillis(yield* DateTime.now);
        const summary = yield* call(ANTIGRAVITY_SUMMARY_URL, { project });
        const windows = yield* antigravitySummaryWindows(yield* decodeJson(summary), requestedAt);
        if (windows.length === 0) {
          return yield* new UsageLimitSourceError({ detail: "No Antigravity quota reported." });
        }
        // Local Antigravity reports no e-mail, so the Google account fingerprint is what pools the two.
        const fingerprint = yield* call("https://www.googleapis.com/oauth2/v2/userinfo").pipe(
          Effect.flatMap(decodeJson),
          Effect.flatMap(antigravityAccountFingerprint),
          Effect.option,
        );
        const usageLimits = makeUsageLimits({ checkedAt, windows });
        return Option.match(fingerprint, {
          onNone: () => ({ ...listedIdentity(account), usageLimits }),
          onSome: (credentialFingerprint) => ({
            usageLimits: { ...usageLimits, credentialFingerprint },
          }),
        });
      }),
    },
  ],
]);

const signInRequiredAccount = (
  account: AuthFile,
  provider: HubProvider,
  checkedAt: string,
): UsageLimitSourceAccount => ({
  id: account.id,
  driver: provider.driver,
  ...listedIdentity(account),
  signInRequired: true,
  usageLimits: makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: "The provider rejected this account's sign-in. Sign in to it again on the hub.",
  }),
});

export const makeCliproxyApi = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const digest = yield* Digest.Digest;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  // The auth file version each rejected account was rejected with, by hub URL and account.
  // Anthropic throttles an account's quota reads for an hour after repeated 401s, so a
  // rejected account is read again only once the hub rewrites its auth file, which a token
  // refresh or a new login does.
  const rejectedVersions = new Map<string, string>();
  const rejectionKey = (hub: CliproxyHub, account: AuthFile) => `${hub.url}\0${account.id}`;

  const management = Effect.fn("CliproxyApi.management")(function* (
    hub: CliproxyHub,
    path: string,
    body?: unknown,
  ) {
    const url = yield* Effect.try({
      try: () => {
        const base = new URL(hub.url);
        // Users often paste the hub's web panel URL, which ends in management.html.
        base.pathname = base.pathname.replace(/(\/management\.html)?\/?$/i, "/");
        return new URL(`v0/management/${path}`, base).toString();
      },
      catch: () => new UsageLimitSourceError({ detail: "The hub URL is not valid." }),
    });
    const request = (
      body === undefined ? HttpClientRequest.get(url) : HttpClientRequest.post(url)
    ).pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${hub.managementKey}`));
    const response = yield* client
      .execute(body === undefined ? request : request.pipe(HttpClientRequest.bodyJsonUnsafe(body)))
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.timeout("15 seconds"),
        Effect.mapError(
          (error) => new UsageLimitSourceError({ detail: describeManagementFailure(error) }),
        ),
      );
    return response;
  });

  const authFiles = Effect.fn("CliproxyApi.authFiles")(function* (hub: CliproxyHub) {
    const response = yield* management(hub, "auth-files");
    return (yield* decodeAuthFiles(response)).files;
  });

  const apiCall = Effect.fn("CliproxyApi.apiCall")(function* (
    hub: CliproxyHub,
    account: AuthFile,
    provider: HubProvider,
    url: string,
    data?: unknown,
  ) {
    const raw = yield* management(hub, "api-call", {
      auth_index: account.auth_index,
      method: data === undefined ? "GET" : "POST",
      url,
      header: provider.header(account, platform, architecture),
      ...(data === undefined ? {} : { data: yield* encodeJson(data) }),
    });
    const response = yield* decodeApiResponse(raw);
    if (response.status_code < 200 || response.status_code >= 300) {
      const retryAfter = Object.entries(response.header ?? {}).find(
        ([name]) => name.toLowerCase() === "retry-after",
      )?.[1][0];
      return yield* usageLimitsStatusError({
        provider: provider.label,
        status: response.status_code,
        retryAfter,
        nowMs: DateTime.toEpochMillis(yield* DateTime.now),
      });
    }
    return response.body;
  });

  const readAccount = Effect.fn("CliproxyApi.readAccount")(function* (
    hub: CliproxyHub,
    account: AuthFile,
    provider: HubProvider,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const call: HubCall = (url, data) => apiCall(hub, account, provider, url, data);
    return yield* provider.read({ account, call, checkedAt }).pipe(
      Effect.provideService(Digest.Digest, digest),
      Effect.map((reading): UsageLimitSourceAccount => ({
        id: account.id,
        driver: provider.driver,
        ...reading,
      })),
      Effect.catch((cause) =>
        Effect.gen(function* () {
          const error = isUsageLimitsReadError(cause)
            ? cause
            : new UsageLimitsReadError({ detail: "The hub could not read this account's usage." });
          yield* Effect.logWarning("hub account usage read failed", {
            provider: account.provider,
            detail: error.detail,
            ...(error.retryAt ? { retryAt: error.retryAt } : {}),
          });
          if (error.status === 401) {
            if (account.modtime) rejectedVersions.set(rejectionKey(hub, account), account.modtime);
            return signInRequiredAccount(account, provider, checkedAt);
          }
          return {
            id: account.id,
            driver: provider.driver,
            ...listedIdentity(account),
            usageLimits: usageLimitsReadFailure(error, checkedAt),
          };
        }),
      ),
    );
  });

  /** `reuse` returns the account's last reading when it must not be read now. */
  const readAccounts = Effect.fn("CliproxyApi.readAccounts")(function* (
    hub: CliproxyHub,
    reuse: (accountId: string) => UsageLimitSourceAccount | undefined = () => undefined,
  ): Effect.fn.Return<ReadonlyArray<UsageLimitSourceAccount>, UsageLimitSourceError> {
    const accounts = yield* authFiles(hub).pipe(
      Effect.mapError((error) =>
        isUsageLimitSourceError(error)
          ? error
          : new UsageLimitSourceError({ detail: "The hub could not list accounts." }),
      ),
    );
    return yield* Effect.forEach(
      accounts.flatMap((account) => {
        const provider = HUB_PROVIDERS.get(account.provider);
        return provider && !account.disabled ? [{ account, provider }] : [];
      }),
      ({ account, provider }) => {
        if (
          account.modtime !== undefined &&
          rejectedVersions.get(rejectionKey(hub, account)) === account.modtime
        ) {
          return DateTime.now.pipe(
            Effect.map((now) => signInRequiredAccount(account, provider, DateTime.formatIso(now))),
          );
        }
        const kept = reuse(account.id);
        return kept ? Effect.succeed(kept) : readAccount(hub, account, provider);
      },
      { concurrency: 4 },
    );
  });

  const consume = Effect.fn("CliproxyApi.consume")(function* (
    hub: CliproxyHub,
    accountId: string,
    creditId: string,
  ): Effect.fn.Return<ProviderConsumeResetCreditResult, UsageLimitSourceError> {
    const operation = Effect.gen(function* () {
      const account = (yield* authFiles(hub)).find((account) => account.id === accountId);
      if (!account || account.disabled || account.provider !== "codex") {
        return yield* new UsageLimitSourceError({
          detail: "The Codex hub account is missing or disabled.",
        });
      }
      const body = yield* apiCall(hub, account, CODEX_HUB, `${CREDIT_URL}/consume`, {
        redeem_request_id: yield* creditRedeemRequestId(
          account.id_token?.chatgpt_account_id ?? account.id,
          creditId,
        ).pipe(Effect.provideService(Digest.Digest, digest)),
        credit_id: creditId,
      });
      const response = yield* decodeConsumeResponse(body);
      const outcome = (
        {
          reset: "reset",
          nothing_to_reset: "nothingToReset",
          no_credit: "noCredit",
          already_redeemed: "alreadyRedeemed",
        } as const
      )[response.code];
      if (outcome !== "reset" && outcome !== "alreadyRedeemed") return { outcome };
      const cleared = yield* management(hub, "reset-quota", {
        auth_index: account.auth_index,
      }).pipe(Effect.result);
      return {
        outcome,
        ...(cleared._tag === "Failure"
          ? {
              warning:
                "Credit redeemed, but the hub cooldown could not be cleared. Routing may resume after its cooldown expires.",
            }
          : {}),
      } as const;
    });
    return yield* operation.pipe(
      Effect.mapError((error) =>
        isUsageLimitSourceError(error)
          ? error
          : isUsageLimitsReadError(error)
            ? new UsageLimitSourceError({ detail: error.detail })
            : new UsageLimitSourceError({
                detail: "The hub returned an unexpected reset-credit response.",
              }),
      ),
    );
  });
  return { readAccounts, consume };
});
