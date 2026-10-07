import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { paceOf, remainingPercent } from "@t3tools/shared/usageLimits";

const HOUR_MINUTES = 60;
const DAY_MINUTES = 24 * HOUR_MINUTES;

/** The session window and the first weekly one; other windows fill in when either is missing. */
export function meterWindows(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  const preferred = [
    windows.find((window) => window.kind === "session"),
    windows.find((window) => window.kind === "weekly"),
  ].filter((window) => window !== undefined);
  return [...preferred, ...windows.filter((window) => !preferred.includes(window))].slice(0, 2);
}

/** `5h`, `1w`, `30d`. */
export function windowShortLabel(window: ServerProviderUsageWindow): string {
  const minutes = window.windowDurationMins;
  if (!minutes) return window.label;
  if (minutes < DAY_MINUTES) return `${Math.round(minutes / HOUR_MINUTES)}h`;
  const days = Math.round(minutes / DAY_MINUTES);
  return days % 7 === 0 ? `${days / 7}w` : `${days}d`;
}

export type MeterTone = "normal" | "ahead" | "low";

/** Nearly out wins over pace, which only says the window may run dry before it resets. */
export function meterTone(window: ServerProviderUsageWindow, now: number): MeterTone {
  if (remainingPercent(window) <= 10) return "low";
  return paceOf(window, now) === "ahead" ? "ahead" : "normal";
}
