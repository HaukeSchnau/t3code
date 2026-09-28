/**
 * Z.AI Coding Plan usage for OpenCode instances. OpenCode resolves the Z.AI
 * API key from its own provider config; T3 reads the matching quota endpoint
 * and publishes the result as ordinary provider usage windows, so the probe
 * and the adapter's live updates land on the same rows.
 *
 * @module provider/zaiUsage
 */
import type { ProviderListResponse } from "@opencode-ai/sdk/v2";
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { parseOpenCodeModelSlug } from "./opencodeRuntime.ts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "./providerUsageLimits.ts";

const ZAI_QUOTA_PATH = "/api/monitor/usage/quota/limit";
const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;

const ZaiQuotaLimit = Schema.Struct({
  type: Schema.String,
  unit: Schema.Int,
  number: Schema.Int,
  percentage: Schema.Number,
  nextResetTime: Schema.optional(Schema.NullOr(Schema.Number)),
});
type ZaiQuotaLimit = typeof ZaiQuotaLimit.Type;

// Plan metadata varies by account and is not shown; undeclared keys are ignored.
const ZaiQuotaResponse = Schema.Struct({
  code: Schema.Number,
  success: Schema.Boolean,
  data: Schema.Struct({ limits: Schema.Array(ZaiQuotaLimit) }),
});

const decodeZaiQuotaResponse = Schema.decodeUnknownExit(ZaiQuotaResponse);
const decodeStringOption = Schema.decodeUnknownOption(Schema.String);

export interface ZaiUsageSource {
  readonly apiKey: string;
  readonly quotaUrl: string;
}

export class ZaiUsageError extends Schema.TaggedError<ZaiUsageError>()("ZaiUsageError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

function trimmed(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text && text.length > 0 ? text : undefined;
}

function codingDurationMinutes(unit: number, count: number): number | null {
  if (count <= 0) return null;
  switch (unit) {
    case 1:
      return count * 24 * 60;
    case 3:
      return count * 60;
    case 6:
      return count * 7 * 24 * 60;
    default:
      return null;
  }
}

function resetEpochMillis(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value >= 1_000_000_000_000 ? value : value * 1000;
}

function mcpDurationMinutes(
  unit: number,
  count: number,
  nextResetTime: number | null | undefined,
): number | null {
  if (unit !== 5 || count <= 0) return null;

  // Z.AI encodes this as calendar months. Derive the real span from the reset
  // date so February and 31-day months pace from the correct start.
  const resetEpochMs = resetEpochMillis(nextResetTime);
  const reset = resetEpochMs === null ? Option.none() : DateTime.make(resetEpochMs);
  return Option.match(reset, {
    onNone: () => count * 30 * 24 * 60,
    onSome: (resetAt) =>
      Math.round(
        (DateTime.toEpochMillis(resetAt) -
          DateTime.toEpochMillis(DateTime.subtract(resetAt, { months: count }))) /
          (60 * 1000),
      ),
  });
}

function resetsAt(value: number | null | undefined): { readonly resetsAt?: string } {
  const epochMs = resetEpochMillis(value);
  return Option.match(epochMs === null ? Option.none() : DateTime.make(epochMs), {
    onNone: () => ({}),
    onSome: (resetAt) => ({ resetsAt: DateTime.formatIso(resetAt) }),
  });
}

function zaiUsageWindow(limit: ZaiQuotaLimit): ReadonlyArray<ServerProviderUsageWindow> {
  const usage = { usedPercent: clampPercent(limit.percentage), ...resetsAt(limit.nextResetTime) };
  if (limit.type === "TOKENS_LIMIT") {
    const windowDurationMins = codingDurationMinutes(limit.unit, limit.number);
    if (windowDurationMins === SESSION_MINS) {
      return [
        { id: "zai_5h", kind: "session", label: "GLM · Session", windowDurationMins, ...usage },
      ];
    }
    if (windowDurationMins === WEEK_MINS) {
      return [
        { id: "zai_weekly", kind: "weekly", label: "GLM · Weekly", windowDurationMins, ...usage },
      ];
    }
    return [];
  }
  if (limit.type === "TIME_LIMIT") {
    const windowDurationMins = mcpDurationMinutes(limit.unit, limit.number, limit.nextResetTime);
    return windowDurationMins === null
      ? []
      : [{ id: "zai_mcp", kind: "monthly", label: "GLM · MCP", windowDurationMins, ...usage }];
  }
  return [];
}

/**
 * Converts Z.AI's Coding Plan quota response into usage windows. The monthly
 * MCP allowance (Web Search, Web Reader and ZRead calls) gets its own window
 * so it never displaces the five-hour and weekly coding windows. A response
 * without a coding window is not a Coding Plan and yields nothing.
 */
export function zaiUsageWindowsFromResponse(
  value: unknown,
): ReadonlyArray<ServerProviderUsageWindow> | undefined {
  const decoded = decodeZaiQuotaResponse(value);
  if (Exit.isFailure(decoded) || !decoded.value.success || decoded.value.code !== 200) {
    return undefined;
  }
  const windows = decoded.value.data.limits.flatMap(zaiUsageWindow);
  return windows.some((window) => window.id !== "zai_mcp") ? windows : undefined;
}

export function zaiQuotaUrlForApiUrl(apiUrl: string): string | null {
  const parsed = Result.getOrNull(Result.try(() => new URL(apiUrl)));
  if (!parsed || parsed.protocol !== "https:") return null;
  if (parsed.hostname !== "api.z.ai" && parsed.hostname !== "open.bigmodel.cn") return null;
  return new URL(ZAI_QUOTA_PATH, parsed.origin).toString();
}

type OpenCodeProvider = ProviderListResponse["all"][number];

function providerZaiUsageSource(
  provider: OpenCodeProvider,
  model: OpenCodeProvider["models"][string],
): ZaiUsageSource | null {
  const quotaUrl = zaiQuotaUrlForApiUrl(model.api.url);
  if (!quotaUrl) return null;
  const apiKey =
    trimmed(provider.key) ??
    trimmed(Option.getOrUndefined(decodeStringOption(provider.options.apiKey)));
  return apiKey ? { apiKey, quotaUrl } : null;
}

/** Resolves Z.AI quota access for the model a session selected. */
export function openCodeZaiUsageSource(
  providerList: ProviderListResponse,
  modelSlug: string | null | undefined,
): ZaiUsageSource | null {
  const parsed = parseOpenCodeModelSlug(modelSlug);
  if (!parsed) return null;
  const provider = providerList.all.find((candidate) => candidate.id === parsed.providerID);
  const model = provider?.models[parsed.modelID];
  return provider && model ? providerZaiUsageSource(provider, model) : null;
}

/** A probe has no selected model; the first provider serving a Z.AI model qualifies. */
export function openCodeInventoryZaiUsageSource(
  providerList: ProviderListResponse,
): ZaiUsageSource | null {
  for (const provider of providerList.all) {
    for (const model of Object.values(provider.models)) {
      const source = providerZaiUsageSource(provider, model);
      if (source) return source;
    }
  }
  return null;
}

/** Reads one quota snapshot. Callers own scheduling and best-effort error handling. */
export const fetchZaiUsageWindows = Effect.fn("fetchZaiUsageWindows")(function* (
  source: ZaiUsageSource,
) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* HttpClientRequest.get(source.quotaUrl).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.setHeader("authorization", source.apiKey),
    client.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(ZaiQuotaResponse)),
    Effect.mapError(
      (cause) =>
        new ZaiUsageError({
          detail: "Failed to read GLM Coding Plan usage.",
          cause,
        }),
    ),
  );
  const windows = zaiUsageWindowsFromResponse(response);
  if (!windows) {
    return yield* new ZaiUsageError({
      detail: "Z.AI returned no usable coding quota windows.",
    });
  }
  return windows;
});

/**
 * Adds the Z.AI Coding Plan to an OpenCode probe's usage limits. The OpenCode
 * Go read reports `unsupported` without a Go key, and runtime updates never
 * land on an unsupported snapshot, so a configured Z.AI provider has to count
 * here. A source lookup that fails leaves the Go result unchanged.
 */
export const withZaiUsageLimits = <E, R>(
  limits: ServerProviderUsageLimits,
  source: Effect.Effect<ZaiUsageSource | null, E, R>,
) =>
  Effect.gen(function* () {
    // The lookup may start OpenCode's local server, which has its own start timeout.
    const resolved = yield* source.pipe(Effect.orElseSucceed(() => null));
    if (!resolved) return limits;
    return yield* fetchZaiUsageWindows(resolved).pipe(
      Effect.timeout("5 seconds"),
      Effect.map((windows) =>
        makeUsageLimits({
          checkedAt: limits.checkedAt,
          windows: [...(limits.unavailable ? [] : limits.windows), ...windows],
        }),
      ),
      Effect.orElseSucceed(() =>
        limits.unavailable?.reason === "unsupported"
          ? makeUnavailableUsageLimits({
              checkedAt: limits.checkedAt,
              reason: "probeFailed",
              message: "Z.AI could not read usage.",
            })
          : limits,
      ),
    );
  });
