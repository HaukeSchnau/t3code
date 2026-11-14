import type {
  EnvironmentId,
  ServerProvider,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectLimitPools,
  type LimitPace,
  type LimitPool,
  limitsNotice,
  paceOf,
  remainingPercent,
} from "@t3tools/shared/usageLimits";

const HOUR_MINUTES = 60;
const DAY_MINUTES = 24 * HOUR_MINUTES;

/** What the meter reads: the provider's own account, or the hub accounts it draws on. */
export type MeterSource =
  | { readonly kind: "account"; readonly windows: ReadonlyArray<ServerProviderUsageWindow> }
  | { readonly kind: "pool"; readonly pool: LimitPool };

/**
 * The provider's own windows. A provider that cannot report any, such as
 * Claude sending through a hub with its API key, reads the hub's accounts of
 * its driver pooled, the numbers Usage → Limits leads with.
 */
export function meterSource(
  environmentId: EnvironmentId,
  provider: ServerProvider,
  sources: UsageLimitSourceSnapshots,
  now: number,
): MeterSource | null {
  const limits = provider.usageLimits;
  if (limits && limitsNotice(limits) === null) return { kind: "account", windows: limits.windows };
  if (limits?.unavailable?.reason !== "unsupported") return null;
  const accounts = collectLimitAccounts(
    new Map([
      [
        environmentId,
        {
          entry: { target: { label: "" } },
          serverConfig: { providers: [], usageLimitSources: sources },
        },
      ],
    ]),
  ).filter((account) => account.driver === provider.driver);
  const [pool] = collectLimitPools(accounts, now);
  return pool ? { kind: "pool", pool } : null;
}

// The contract has no model scope on a window, so Claude's "Weekly · <model>" label is the only marker.
const MODEL_SCOPED_LABEL = /^Weekly · (.+)$/;

/** The model a weekly window is limited to, such as `Fable`, or null for an all-models window. */
function windowModelScope(window: { readonly label: string }): string | null {
  return MODEL_SCOPED_LABEL.exec(window.label)?.[1]?.trim() || null;
}

function scopeMatchesModel(scope: string, model: string): boolean {
  const words = scope
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const modelWords = new Set(model.toLowerCase().split(/[^a-z0-9]+/));
  return words.length > 0 && words.every((word) => modelWords.has(word));
}

/**
 * The session window and the first all-models weekly one, then the selected
 * model's own weekly; other windows fill in when one is missing. Weeklies
 * scoped to another model stay off the meter.
 */
export function meterWindows<
  Window extends { readonly kind: ServerProviderUsageWindow["kind"]; readonly label: string },
>(windows: ReadonlyArray<Window>, model: string | null): ReadonlyArray<Window> {
  const candidates = windows.filter((window) => {
    const scope = windowModelScope(window);
    return scope === null || (model !== null && scopeMatchesModel(scope, model));
  });
  const preferred = [
    candidates.find((window) => window.kind === "session"),
    candidates.find((window) => window.kind === "weekly" && windowModelScope(window) === null),
    candidates.find((window) => windowModelScope(window) !== null),
  ].filter((window) => window !== undefined);
  return [...preferred, ...candidates.filter((window) => !preferred.includes(window))].slice(0, 2);
}

/** `5h`, `1w`, `30d`, or the model a weekly window is scoped to. */
export function windowShortLabel(
  window: Pick<ServerProviderUsageWindow, "label" | "windowDurationMins">,
): string {
  const scope = windowModelScope(window);
  if (scope) return scope;
  const minutes = window.windowDurationMins;
  if (!minutes) return window.label;
  if (minutes < DAY_MINUTES) return `${Math.round(minutes / HOUR_MINUTES)}h`;
  const days = Math.round(minutes / DAY_MINUTES);
  return days % 7 === 0 ? `${days / 7}w` : `${days}d`;
}

export type MeterTone = "normal" | "ahead" | "low";

export interface MeterRow {
  readonly id: string;
  readonly label: string;
  readonly shortLabel: string;
  readonly remaining: number;
  readonly tone: MeterTone;
}

/** Nearly out wins over pace, which only says the window may run dry before it resets. */
function meterTone(remaining: number, pace: LimitPace | null): MeterTone {
  if (remaining <= 10) return "low";
  return pace === "ahead" ? "ahead" : "normal";
}

/** The two bars the meter draws for the selected model, pooled when the source is a pool. */
export function meterRows(
  source: MeterSource,
  model: string | null,
  now: number,
): ReadonlyArray<MeterRow> {
  if (source.kind === "account") {
    return meterWindows(source.windows, model).map((window) => {
      const remaining = remainingPercent(window);
      return {
        id: window.id,
        label: window.label,
        shortLabel: windowShortLabel(window),
        remaining,
        tone: meterTone(remaining, paceOf(window, now)),
      };
    });
  }
  return meterWindows(source.pool.windows, model).map((window) => ({
    id: window.id,
    label: window.label,
    shortLabel: windowShortLabel({
      label: window.label,
      windowDurationMins: window.members[0]?.window.windowDurationMins,
    }),
    remaining: window.remainingPercent,
    tone: meterTone(window.remainingPercent, window.pace),
  }));
}
