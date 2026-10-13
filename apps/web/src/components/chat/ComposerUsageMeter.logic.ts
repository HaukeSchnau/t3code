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
        { entry: { target: { label: "" } }, serverConfig: { usageLimitSources: sources } },
      ],
    ]),
  ).filter((account) => account.driver === provider.driver);
  const [pool] = collectLimitPools(accounts, now);
  return pool ? { kind: "pool", pool } : null;
}

/** The session window and the first weekly one; other windows fill in when either is missing. */
export function meterWindows<Window extends { readonly kind: ServerProviderUsageWindow["kind"] }>(
  windows: ReadonlyArray<Window>,
): ReadonlyArray<Window> {
  const preferred = [
    windows.find((window) => window.kind === "session"),
    windows.find((window) => window.kind === "weekly"),
  ].filter((window) => window !== undefined);
  return [...preferred, ...windows.filter((window) => !preferred.includes(window))].slice(0, 2);
}

/** `5h`, `1w`, `30d`. */
export function windowShortLabel(
  window: Pick<ServerProviderUsageWindow, "label" | "windowDurationMins">,
): string {
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

/** The two bars the meter draws, pooled when the source is a pool. */
export function meterRows(source: MeterSource, now: number): ReadonlyArray<MeterRow> {
  if (source.kind === "account") {
    return meterWindows(source.windows).map((window) => {
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
  return meterWindows(source.pool.windows).map((window) => ({
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
