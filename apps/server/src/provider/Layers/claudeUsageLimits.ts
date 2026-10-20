/**
 * Claude Code subscription usage. Both sources produce windows with the same
 * ids so a turn-driven `rate_limit_event` lands on the row the SDK's
 * `get_usage` read established:
 *
 * - `get_usage` (on demand, during the capabilities probe) reports every
 *   window at once as 0–100 percentages with ISO reset times.
 * - `rate_limit_event` (streamed during a turn) names one window at a time
 *   with a 0–1 utilization fraction and an epoch-seconds reset.
 *
 * @module provider/Layers/claudeUsageLimits
 */
import type { SDKControlGetUsageResponse, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClientRequest } from "effect/unstable/http";

import {
  clampPercent,
  fetchUsageLimitsBody,
  makeUnavailableUsageLimits,
  makeUsageLimits,
  UsageLimitsReadError,
} from "../providerUsageLimits.ts";
import {
  CLAUDE_USAGE_URL,
  claudeResetCreditsToContract,
  readClaudeAccessToken,
  withClaudeHeaders,
} from "./claudeResetCredits.ts";

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;

/**
 * The account-wide windows, keyed by the SDK's `rateLimitType`. Model-scoped
 * weeklies are additive on top of these: the CLI reports them under
 * `rate_limits.model_scoped[]` on `get_usage` and streams the overage-included
 * model bucket (Fable today) as `seven_day_overage_included`.
 */
const WINDOWS: Readonly<
  Record<string, Pick<ServerProviderUsageWindow, "kind" | "label" | "windowDurationMins">>
> = {
  five_hour: { kind: "session", label: "Session", windowDurationMins: SESSION_MINS },
  seven_day: { kind: "weekly", label: "Weekly", windowDurationMins: WEEK_MINS },
};

/**
 * The streamed event names the overage-included bucket by type
 * (`seven_day_overage_included`), while `get_usage` names it by the model's
 * `display_name`. Which model that is changes over time, so the probe records
 * the name it saw and the event mapper reuses it; the mid-turn update then
 * lands on the row the probe drew instead of opening a second one.
 */
const OVERAGE_INCLUDED_EVENT_TYPE = "seven_day_overage_included";

export interface ClaudeScopedLimitNames {
  readonly overageIncluded: string | undefined;
}

export const makeClaudeScopedLimitNames = Ref.make<ClaudeScopedLimitNames>({
  overageIncluded: undefined,
});

function scopedWindowId(displayName: string): string {
  return `seven_day_${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

function scopedWindow(
  displayName: string,
  usedPercent: number,
  resetsAt: string | undefined,
): ServerProviderUsageWindow {
  return {
    id: scopedWindowId(displayName),
    kind: "weekly",
    label: `Weekly · ${displayName}`,
    windowDurationMins: WEEK_MINS,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/**
 * `model_scoped` shipped in the CLI after the SDK typings we pin, so it is
 * read structurally until the `.d.ts` catches up.
 */
interface ModelScopedWindow {
  readonly display_name: string;
  readonly utilization: number | null;
  readonly resets_at: string | null;
}

function readModelScoped(rateLimits: object): ReadonlyArray<ModelScopedWindow> {
  const raw = (rateLimits as { readonly model_scoped?: unknown }).model_scoped;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is ModelScopedWindow =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as ModelScopedWindow).display_name === "string",
  );
}

function isoFromEpochSeconds(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  const dt = DateTime.make(value * 1000);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function isoFromString(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const dt = DateTime.make(value);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function makeWindow(
  id: keyof typeof WINDOWS & string,
  usedPercent: number,
  resetsAt: string | undefined,
): ServerProviderUsageWindow {
  const window = WINDOWS[id]!;
  return {
    id,
    ...window,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/**
 * Utilization is a 0–1 fraction on the streamed event. An overage-included
 * event before any probe has named the bucket is dropped: guessing a name
 * would draw a row the next probe cannot reconcile.
 */
export function claudeRateLimitEventToUpdate(
  info: SDKRateLimitInfo,
  names: ClaudeScopedLimitNames,
): ProviderUsageLimitsUpdate | undefined {
  const type: string | undefined = info.rateLimitType;
  if (!type || typeof info.utilization !== "number") {
    return undefined;
  }
  const usedPercent = info.utilization * 100;
  const resetsAt = isoFromEpochSeconds(info.resetsAt);
  if (type in WINDOWS) {
    return { windows: [makeWindow(type, usedPercent, resetsAt)] };
  }
  if (type === OVERAGE_INCLUDED_EVENT_TYPE && names.overageIncluded) {
    return { windows: [scopedWindow(names.overageIncluded, usedPercent, resetsAt)] };
  }
  return undefined;
}

/**
 * Percentages on the `get_usage` response are already 0–100. Also yields the
 * scoped-bucket names the response carried, for the event mapper to reuse.
 */
export function claudeUsageResponseToLimits(input: {
  readonly response: Pick<SDKControlGetUsageResponse, "rate_limits_available" | "rate_limits">;
  readonly checkedAt: string;
}): { readonly limits: ServerProviderUsageLimits; readonly names: ClaudeScopedLimitNames } {
  const { response, checkedAt } = input;
  if (!response.rate_limits_available || !response.rate_limits) {
    return {
      limits: makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" }),
      names: { overageIncluded: undefined },
    };
  }
  const windows: ServerProviderUsageWindow[] = [];
  for (const id of Object.keys(WINDOWS)) {
    const window = response.rate_limits[id as "five_hour" | "seven_day"];
    if (!window || typeof window.utilization !== "number") continue;
    windows.push(makeWindow(id, window.utilization, isoFromString(window.resets_at)));
  }
  // The CLI filters `model_scoped` to the overage-included allowlist, which
  // today holds one model; the first entry is the one the event refers to.
  let overageIncluded: string | undefined;
  for (const entry of readModelScoped(response.rate_limits)) {
    if (typeof entry.utilization !== "number") continue;
    windows.push(
      scopedWindow(entry.display_name, entry.utilization, isoFromString(entry.resets_at)),
    );
    // Only a bucket that drew a row may receive events; naming one that was
    // skipped would let a mid-turn event open a row the probe never showed.
    overageIncluded ??= entry.display_name;
  }
  return {
    limits: makeUsageLimits({ checkedAt, windows }),
    names: { overageIncluded },
  };
}

/** Probe-side helper: map the response and remember the scoped names for events. */
export const recordClaudeUsageResponse = (
  namesRef: Ref.Ref<ClaudeScopedLimitNames>,
  input: Parameters<typeof claudeUsageResponseToLimits>[0],
): Effect.Effect<ServerProviderUsageLimits> => {
  const { limits, names } = claudeUsageResponseToLimits(input);
  return Ref.set(namesRef, names).pipe(Effect.as(limits));
};

const ClaudeOauthWindow = Schema.Struct({
  utilization: Schema.Number,
  resets_at: Schema.NullOr(Schema.String),
});

/** The body of `/api/oauth/usage`, the endpoint behind `get_usage`, read directly or through a hub. */
export const ClaudeOauthUsage = Schema.Struct({
  five_hour: Schema.optional(Schema.NullOr(ClaudeOauthWindow)),
  seven_day: Schema.optional(Schema.NullOr(ClaudeOauthWindow)),
  limits: Schema.optional(
    Schema.Array(
      Schema.Struct({
        kind: Schema.String,
        percent: Schema.optional(Schema.NullOr(Schema.Number)),
        resets_at: Schema.optional(Schema.NullOr(Schema.String)),
        scope: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              model: Schema.optional(Schema.NullOr(Schema.Struct({ display_name: Schema.String }))),
            }),
          ),
        ),
      }),
    ),
  ),
});

/** The endpoint lists model-scoped weeklies under `limits`, where `get_usage` says `model_scoped`. */
export function claudeOauthUsageToLimits(
  usage: typeof ClaudeOauthUsage.Type,
  checkedAt: string,
): ReturnType<typeof claudeUsageResponseToLimits> {
  const model_scoped = (usage.limits ?? []).flatMap((limit) =>
    limit.kind === "weekly_scoped" && limit.scope?.model && typeof limit.percent === "number"
      ? [
          {
            display_name: limit.scope.model.display_name,
            utilization: limit.percent,
            resets_at: limit.resets_at ?? null,
          },
        ]
      : [],
  );
  return claudeUsageResponseToLimits({
    checkedAt,
    response: {
      rate_limits_available: true,
      rate_limits: {
        five_hour: usage.five_hour ?? null,
        seven_day: usage.seven_day ?? null,
        model_scoped,
      },
    },
  });
}

const decodeClaudeOauthUsage = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      ...ClaudeOauthUsage.fields,
      cedar_ember: Schema.optional(Schema.NullOr(Schema.Unknown)),
    }),
  ),
);

/**
 * Reads the windows and banked resets of the login in `configDir` with the
 * one request the CLI makes for them, without starting Claude. Only
 * file-based logins can be read; macOS keeps Claude's in the keychain.
 */
export const readClaudeUsageLimits = Effect.fn("readClaudeUsageLimits")(function* (input: {
  readonly configDir: string;
  readonly version: string;
  readonly scopedLimitNames: Ref.Ref<ClaudeScopedLimitNames>;
}) {
  const token = yield* readClaudeAccessToken(input.configDir).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (!token) {
    return yield* new UsageLimitsReadError({ detail: "No Claude login file to read usage from." });
  }
  const usage = yield* fetchUsageLimitsBody({
    provider: "Claude",
    request: HttpClientRequest.get(CLAUDE_USAGE_URL, {
      urlParams: { cedar_ember: "1", skip_spend: "1" },
    }).pipe(withClaudeHeaders(token, input.version)),
    decode: decodeClaudeOauthUsage,
  });
  const now = yield* DateTime.now;
  const { limits, names } = claudeOauthUsageToLimits(usage, DateTime.formatIso(now));
  yield* Ref.set(input.scopedLimitNames, names);
  const resetCredits = claudeResetCreditsToContract(usage.cedar_ember, DateTime.toEpochMillis(now));
  return resetCredits ? { ...limits, resetCredits } : limits;
});
