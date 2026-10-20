import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, type HttpClientRequest } from "effect/http";

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function sortWindows(
  windows: Iterable<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  return [...windows].toSorted(
    (left, right) =>
      WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind] ||
      left.id.localeCompare(right.id),
  );
}

export function makeUsageLimits(input: {
  readonly checkedAt: string;
  readonly windows: Iterable<ServerProviderUsageWindow>;
}): ServerProviderUsageLimits {
  return { checkedAt: input.checkedAt, windows: sortWindows(input.windows) };
}

export function makeUnavailableUsageLimits(input: {
  readonly checkedAt: string;
  readonly reason: "unsupported" | "probeFailed";
  readonly message?: string;
}): ServerProviderUsageLimits {
  return {
    checkedAt: input.checkedAt,
    windows: [],
    unavailable: {
      reason: input.reason,
      ...(input.message ? { message: input.message } : {}),
    },
  };
}

export function applyUsageLimitsUpdate(input: {
  readonly previous: ServerProviderUsageLimits | undefined;
  readonly update: ProviderUsageLimitsUpdate;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  const { previous, update } = input;
  if (update.windows.length === 0 || previous?.unavailable?.reason === "unsupported") {
    return previous;
  }
  const merged = new Map(previous?.windows.map((window) => [window.id, window] as const));
  // Codex sends this notification beside every token-usage tick, almost
  // always with unchanged numbers. Decide "nothing changed" per window on
  // the way through so the no-op case never allocates a new snapshot.
  let changed = false;
  for (const window of update.windows) {
    const existing = merged.get(window.id);
    const next: ServerProviderUsageWindow = {
      ...window,
      usedPercent: clampPercent(window.usedPercent),
      ...(window.resetsAt === undefined && existing?.resetsAt !== undefined
        ? { resetsAt: existing.resetsAt }
        : {}),
      ...(window.windowDurationMins === undefined && existing?.windowDurationMins !== undefined
        ? { windowDurationMins: existing.windowDurationMins }
        : {}),
    };
    if (existing === undefined || !usageWindowEquals(existing, next)) {
      merged.set(window.id, next);
      changed = true;
    }
  }
  if (!changed && previous !== undefined) {
    return previous;
  }
  const unavailable =
    previous === undefined ? { reason: "probeFailed" as const } : previous.unavailable;
  return {
    ...makeUsageLimits({ checkedAt: input.checkedAt, windows: merged.values() }),
    ...(previous?.resetCredits !== undefined ? { resetCredits: previous.resetCredits } : {}),
    ...(unavailable !== undefined ? { unavailable } : {}),
  };
}

function usageWindowEquals(a: ServerProviderUsageWindow, b: ServerProviderUsageWindow): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.label === b.label &&
    a.usedPercent === b.usedPercent &&
    a.resetsAt === b.resetsAt &&
    a.windowDurationMins === b.windowDurationMins
  );
}

export function resolveUsageLimitsAfterProbe(input: {
  readonly published: ServerProviderUsageLimits | undefined;
  readonly probed: ServerProviderUsageLimits | undefined;
}): ServerProviderUsageLimits | undefined {
  const { published, probed } = input;
  if (probed?.unavailable?.reason === "probeFailed" && published && !published.unavailable) {
    // A throttled read keeps the last good windows and records when to read again.
    return probed.rateLimitedUntil === undefined ||
      probed.rateLimitedUntil === published.rateLimitedUntil
      ? published
      : { ...published, rateLimitedUntil: probed.rateLimitedUntil };
  }
  if (
    published &&
    probed &&
    !published.unavailable &&
    !probed.unavailable &&
    Date.parse(published.checkedAt) > Date.parse(probed.checkedAt)
  ) {
    return { ...probed, checkedAt: published.checkedAt, windows: published.windows };
  }
  return probed;
}

// Direct quota reads (patches/usage-limits-refresh.md).

/** A quota read sooner than this after the last one reuses that reading. */
export const USAGE_LIMITS_MIN_READ_GAP_MS = 30_000;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 5 * 60_000;

/** A direct quota read that produced no windows. `retryAt` is set when the provider throttled it. */
export class UsageLimitsReadError extends Schema.TaggedError<UsageLimitsReadError>()(
  "UsageLimitsReadError",
  {
    detail: Schema.String,
    retryAt: Schema.optional(Schema.String),
  },
) {}

/** When to read again after a 429: its `Retry-After` in seconds or as a date, else five minutes. */
export function rateLimitRetryAt(retryAfter: string | undefined, nowMs: number): string {
  const value = retryAfter?.trim() ?? "";
  const seconds = /^\d+$/.test(value) ? Number(value) * 1000 + nowMs : undefined;
  const date = seconds === undefined && value ? DateTime.make(value) : Option.none();
  const at = seconds ?? (Option.isSome(date) ? DateTime.toEpochMillis(date.value) : undefined);
  return DateTime.formatIso(
    DateTime.makeUnsafe(
      at !== undefined && at > nowMs ? at : nowMs + DEFAULT_RATE_LIMIT_BACKOFF_MS,
    ),
  );
}

/** The error a non-2xx quota response stands for. */
export function usageLimitsStatusError(input: {
  readonly provider: string;
  readonly status: number;
  readonly retryAfter: string | undefined;
  readonly nowMs: number;
}): UsageLimitsReadError {
  return input.status === 429
    ? new UsageLimitsReadError({
        detail: `${input.provider} is rate-limiting usage reads.`,
        retryAt: rateLimitRetryAt(input.retryAfter, input.nowMs),
      })
    : new UsageLimitsReadError({
        detail: `${input.provider} refused the usage request (HTTP ${input.status}).`,
      });
}

/** GET a provider's quota endpoint and decode the body, mapping every failure to a read error. */
export const fetchUsageLimitsBody = Effect.fn("fetchUsageLimitsBody")(function* <A, E>(input: {
  readonly provider: string;
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly decode: (text: string) => Effect.Effect<A, E>;
}) {
  const client = yield* HttpClient.HttpClient;
  const unanswered = () =>
    new UsageLimitsReadError({ detail: `${input.provider} did not answer the usage request.` });
  const response = yield* client
    .execute(input.request)
    .pipe(Effect.timeout("10 seconds"), Effect.mapError(unanswered));
  if (response.status < 200 || response.status >= 300) {
    return yield* usageLimitsStatusError({
      provider: input.provider,
      status: response.status,
      retryAfter: response.headers["retry-after"],
      nowMs: DateTime.toEpochMillis(yield* DateTime.now),
    });
  }
  const text = yield* response.text.pipe(Effect.timeout("10 seconds"), Effect.mapError(unanswered));
  return yield* input.decode(text).pipe(
    Effect.mapError(
      () =>
        new UsageLimitsReadError({
          detail: `${input.provider} sent an unexpected usage response.`,
        }),
    ),
  );
});

/** The limits a failed read publishes; `resolveUsageLimitsAfterProbe` keeps any earlier reading over them. */
export function usageLimitsReadFailure(
  error: UsageLimitsReadError,
  checkedAt: string,
): ServerProviderUsageLimits {
  return {
    ...makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed", message: error.detail }),
    ...(error.retryAt ? { rateLimitedUntil: error.retryAt } : {}),
  };
}

/** Whether the provider asked not to read these limits again yet. */
export function isUsageLimitsThrottled(
  limits: ServerProviderUsageLimits | undefined,
  nowMs: number,
): boolean {
  return limits?.rateLimitedUntil !== undefined && Date.parse(limits.rateLimitedUntil) > nowMs;
}
