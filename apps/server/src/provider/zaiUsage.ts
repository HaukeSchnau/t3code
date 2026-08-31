import type { OrchestrationUsageLimitsSnapshot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

const ZAI_QUOTA_PATH = "/api/monitor/usage/quota/limit";

const ZaiQuotaLimit = Schema.Struct({
  type: Schema.String,
  unit: Schema.Int,
  number: Schema.Int,
  percentage: Schema.Number,
  nextResetTime: Schema.optional(Schema.NullOr(Schema.Number)),
});

const ZaiQuotaData = Schema.Struct({
  limits: Schema.Array(ZaiQuotaLimit),
  level: Schema.optional(Schema.NullOr(Schema.String)),
  planName: Schema.optional(Schema.NullOr(Schema.String)),
  plan: Schema.optional(Schema.NullOr(Schema.String)),
  plan_type: Schema.optional(Schema.NullOr(Schema.String)),
  packageName: Schema.optional(Schema.NullOr(Schema.String)),
});

const ZaiQuotaResponse = Schema.Struct({
  code: Schema.Number,
  success: Schema.Boolean,
  data: ZaiQuotaData,
});

const decodeZaiQuotaResponse = Schema.decodeUnknownExit(ZaiQuotaResponse);

export type ZaiUsageLimits = Omit<OrchestrationUsageLimitsSnapshot, "updatedAt">;

export interface ZaiUsageSource {
  readonly apiKey: string;
  readonly limitId: string;
  readonly quotaUrl: string;
}

export class ZaiUsageError extends Schema.TaggedErrorClass<ZaiUsageError>()("ZaiUsageError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text && text.length > 0 ? text : null;
}

function durationMinutes(unit: number, count: number): number | null {
  if (count <= 0) return null;
  switch (unit) {
    case 1:
      return count * 24 * 60;
    case 3:
      return count * 60;
    case 5:
      return count;
    case 6:
      return count * 7 * 24 * 60;
    default:
      return null;
  }
}

function resetTimestamp(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const epochMs = value >= 1_000_000_000_000 ? value : value * 1000;
  return Option.match(DateTime.make(epochMs), {
    onNone: () => null,
    onSome: DateTime.formatIso,
  });
}

function windowLabel(durationMins: number): string {
  if (durationMins === 5 * 60) return "Current window";
  if (durationMins === 7 * 24 * 60) return "Weekly";
  return "Coding quota";
}

/** Converts Z.AI's coding-plan response into T3's provider-neutral percentage windows. */
export function zaiUsageLimitsFromResponse(
  value: unknown,
  limitId: string,
): ZaiUsageLimits | undefined {
  const decoded = decodeZaiQuotaResponse(value);
  if (Exit.isFailure(decoded) || !decoded.value.success || decoded.value.code !== 200) {
    return undefined;
  }

  const windows = decoded.value.data.limits
    .flatMap((limit) => {
      if (limit.type !== "TOKENS_LIMIT") return [];
      const windowDurationMins = durationMinutes(limit.unit, limit.number);
      if (windowDurationMins === null || !Number.isFinite(limit.percentage)) return [];
      return [
        {
          key: `zai:tokens:${limit.unit}:${limit.number}`,
          label: windowLabel(windowDurationMins),
          usedPercent: Math.max(0, Math.min(100, limit.percentage)),
          resetsAt: resetTimestamp(limit.nextResetTime),
          windowDurationMins,
        },
      ];
    })
    .toSorted((left, right) => left.windowDurationMins - right.windowDurationMins);
  if (windows.length === 0) return undefined;

  const planType =
    [
      decoded.value.data.level,
      decoded.value.data.planName,
      decoded.value.data.plan,
      decoded.value.data.plan_type,
      decoded.value.data.packageName,
    ]
      .map(trimmed)
      .find((value) => value !== null) ?? null;

  return {
    limitId,
    limitName: "GLM Coding Plan",
    planType,
    rateLimitReachedType: null,
    credits: null,
    primary: windows[0] ?? null,
    secondary: windows.length > 1 ? (windows.at(-1) ?? null) : null,
    windows,
  };
}

export function zaiQuotaUrlForApiUrl(apiUrl: string): string | null {
  const parsed = Result.getOrNull(Result.try(() => new URL(apiUrl)));
  if (!parsed || parsed.protocol !== "https:") return null;
  if (parsed.hostname !== "api.z.ai" && parsed.hostname !== "open.bigmodel.cn") return null;
  return new URL(ZAI_QUOTA_PATH, parsed.origin).toString();
}

/** Reads one quota snapshot. Callers own scheduling and best-effort error handling. */
export const fetchZaiUsageLimits = Effect.fn("fetchZaiUsageLimits")(function* (
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
  const usageLimits = zaiUsageLimitsFromResponse(response, source.limitId);
  if (!usageLimits) {
    return yield* new ZaiUsageError({
      detail: "Z.AI returned no usable coding quota windows.",
    });
  }
  return usageLimits;
});
