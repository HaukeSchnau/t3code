import * as NodeCrypto from "node:crypto";

import {
  ProviderDriverKind,
  UsageLimitSourceError,
  type ProviderConsumeResetCreditResult,
  type UsageLimitSourceAccount,
  type UsageLimitSourceConfig,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { codexPlanLabel } from "../provider/Layers/CodexProvider.ts";
import {
  CODEX_USAGE_BASE,
  CodexUsage,
  codexBackendHeaders,
  codexUsageToLimits,
} from "../provider/Layers/codexUsageLimits.ts";
import { CLAUDE_USAGE_URL } from "../provider/Layers/claudeResetCredits.ts";
import {
  ClaudeOauthUsage,
  claudeOauthUsageToLimits,
} from "../provider/Layers/claudeUsageLimits.ts";
import {
  UsageLimitsReadError,
  usageLimitsReadFailure,
  usageLimitsStatusError,
} from "../provider/providerUsageLimits.ts";

const AuthFile = Schema.Struct({
  id: Schema.String,
  auth_index: Schema.String,
  provider: Schema.String,
  email: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
  id_token: Schema.optional(
    Schema.Struct({
      chatgpt_account_id: Schema.optional(Schema.String),
      chatgpt_plan_type: Schema.optional(Schema.String),
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
const isUsageLimitSourceError = Schema.is(UsageLimitSourceError);
const isUsageLimitsReadError = Schema.is(UsageLimitsReadError);
const decodeConsumeResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      code: Schema.Literals(["reset", "nothing_to_reset", "no_credit", "already_redeemed"]),
    }),
  ),
);

const CREDIT_URL = `${CODEX_USAGE_BASE}/rate-limit-reset-credits`;

// UUIDv5 per account and credit also deduplicates retries across T3 environments.
export function creditRedeemRequestId(accountId: string, creditId: string): string {
  const bytes = NodeCrypto.createHash("sha1")
    .update(Buffer.from("6f1c2a9e2d4b4c1e9a7f3b8d5e0c1a42", "hex"))
    .update(`${accountId}:${creditId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const makeCliproxyApi = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  const management = Effect.fn("CliproxyApi.management")(function* (
    config: UsageLimitSourceConfig,
    path: string,
    body?: unknown,
  ) {
    const url = yield* Effect.try({
      try: () => new URL(`/v0/management/${path}`, config.url).toString(),
      catch: () => new UsageLimitSourceError({ detail: "The hub URL is not valid." }),
    });
    const request = (
      body === undefined ? HttpClientRequest.get(url) : HttpClientRequest.post(url)
    ).pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${config.managementKey}`));
    const response = yield* client
      .execute(body === undefined ? request : request.pipe(HttpClientRequest.bodyJsonUnsafe(body)))
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.timeout("15 seconds"),
        Effect.mapError(
          () => new UsageLimitSourceError({ detail: "The hub management request failed." }),
        ),
      );
    return response;
  });

  const authFiles = Effect.fn("CliproxyApi.authFiles")(function* (config: UsageLimitSourceConfig) {
    const response = yield* management(config, "auth-files");
    return (yield* decodeAuthFiles(response)).files;
  });

  const apiCall = Effect.fn("CliproxyApi.apiCall")(function* (
    config: UsageLimitSourceConfig,
    account: typeof AuthFile.Type,
    url: string,
    data?: unknown,
  ) {
    const header =
      account.provider === "codex"
        ? {
            Authorization: "Bearer $TOKEN$",
            ...codexBackendHeaders(account.id_token?.chatgpt_account_id),
          }
        : { Authorization: "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20" };
    const raw = yield* management(config, "api-call", {
      auth_index: account.auth_index,
      method: data === undefined ? "GET" : "POST",
      url,
      header,
      ...(data === undefined ? {} : { data: yield* encodeJson(data) }),
    });
    const response = yield* decodeApiResponse(raw);
    if (response.status_code < 200 || response.status_code >= 300) {
      const retryAfter = Object.entries(response.header ?? {}).find(
        ([name]) => name.toLowerCase() === "retry-after",
      )?.[1][0];
      return yield* usageLimitsStatusError({
        provider: account.provider === "codex" ? "Codex" : "Claude",
        status: response.status_code,
        retryAfter,
        nowMs: DateTime.toEpochMillis(yield* DateTime.now),
      });
    }
    return response.body;
  });

  const credits = Effect.fn("CliproxyApi.credits")(function* (
    config: UsageLimitSourceConfig,
    account: typeof AuthFile.Type,
  ) {
    const body = yield* apiCall(config, account, CREDIT_URL);
    const response = yield* decodeCreditList(body);
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

  const readAccount = Effect.fn("CliproxyApi.readAccount")(function* (
    config: UsageLimitSourceConfig,
    account: typeof AuthFile.Type,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const base = {
      id: account.id,
      driver: ProviderDriverKind.make(account.provider === "codex" ? "codex" : "claudeAgent"),
      ...(account.email ? { email: account.email } : {}),
    };
    const read = Effect.gen(function* () {
      if (account.provider === "claude") {
        const usage = yield* decodeClaudeUsage(yield* apiCall(config, account, CLAUDE_USAGE_URL));
        return {
          ...base,
          plan: "Claude Subscription",
          usageLimits: claudeOauthUsageToLimits(usage, checkedAt).limits,
        };
      }
      const body = yield* apiCall(config, account, `${CODEX_USAGE_BASE}/usage`);
      const usage = yield* decodeCodexUsage(body);
      // A credits outage must not hide successfully fetched quota windows.
      const available = yield* credits(config, account).pipe(Effect.orElseSucceed(() => undefined));
      const next = available?.[0];
      return {
        ...base,
        plan: codexPlanLabel(usage.plan_type ?? account.id_token?.chatgpt_plan_type),
        usageLimits: {
          ...codexUsageToLimits(usage, checkedAt),
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
    });
    return yield* read.pipe(
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
          return { ...base, usageLimits: usageLimitsReadFailure(error, checkedAt) };
        }),
      ),
    );
  });

  /** `reuse` returns the account's last reading when it must not be read now. */
  const readAccounts = Effect.fn("CliproxyApi.readAccounts")(function* (
    config: UsageLimitSourceConfig,
    reuse: (accountId: string) => UsageLimitSourceAccount | undefined = () => undefined,
  ): Effect.fn.Return<ReadonlyArray<UsageLimitSourceAccount>, UsageLimitSourceError> {
    const accounts = yield* authFiles(config).pipe(
      Effect.mapError(
        () => new UsageLimitSourceError({ detail: "The hub could not list accounts." }),
      ),
    );
    return yield* Effect.forEach(
      accounts.filter(
        (account) =>
          !account.disabled && (account.provider === "codex" || account.provider === "claude"),
      ),
      (account) => {
        const kept = reuse(account.id);
        return kept ? Effect.succeed(kept) : readAccount(config, account);
      },
      { concurrency: 4 },
    );
  });

  const consume = Effect.fn("CliproxyApi.consume")(function* (
    config: UsageLimitSourceConfig,
    accountId: string,
    creditId: string,
  ): Effect.fn.Return<ProviderConsumeResetCreditResult, UsageLimitSourceError> {
    const operation = Effect.gen(function* () {
      const account = (yield* authFiles(config)).find((account) => account.id === accountId);
      if (!account || account.disabled || account.provider !== "codex") {
        return yield* new UsageLimitSourceError({
          detail: "The Codex hub account is missing or disabled.",
        });
      }
      const body = yield* apiCall(config, account, `${CREDIT_URL}/consume`, {
        redeem_request_id: creditRedeemRequestId(
          account.id_token?.chatgpt_account_id ?? account.id,
          creditId,
        ),
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
      const cleared = yield* management(config, "reset-quota", {
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
