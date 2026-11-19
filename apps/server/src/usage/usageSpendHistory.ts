import type { ServerProviderUsageWindow } from "@t3tools/contracts";

const HOUR = 3_600_000;
/** How far back the measured pace looks. */
export const SPEND_HISTORY_HOURS = 72;
/** Less than a day of readings says more about the time of day than about the pace. */
const MIN_OBSERVED_HOURS = 24;

/** A reading: when, how much of the window was used, and when the window resets. */
export type SpendSample = readonly [at: number, usedPercent: number, resetsAt: number | null];

function sampleOf(window: ServerProviderUsageWindow, at: number): SpendSample {
  const resetsAt = window.resetsAt === undefined ? null : Date.parse(window.resetsAt);
  return [at, window.usedPercent, Number.isFinite(resetsAt) ? resetsAt : null];
}

// Providers report a reset time that drifts by seconds between reads; a new window moves it by days.
function startsNewWindow(previous: SpendSample, next: SpendSample): boolean {
  const [, usedBefore, resetBefore] = previous;
  const [, usedAfter, resetAfter] = next;
  const resetMoved = resetBefore !== null && resetAfter !== null && resetAfter - resetBefore > HOUR;
  return resetMoved || usedAfter < usedBefore - 0.5;
}

function sameReading(previous: SpendSample, next: SpendSample): boolean {
  return previous[1] === next[1] && !startsNewWindow(previous, next);
}

/**
 * Adds a reading when it changed, or hourly so quiet hours count as observed, and drops readings
 * older than the history except the one the first newer change is measured from.
 */
export function recordSpendSample(
  samples: readonly SpendSample[],
  window: ServerProviderUsageWindow,
  now: number,
): readonly SpendSample[] {
  const sample = sampleOf(window, now);
  const last = samples.at(-1);
  const next =
    last && sameReading(last, sample) && now - last[0] < HOUR ? samples : [...samples, sample];
  const firstInside = next.findIndex(([at]) => at >= now - SPEND_HISTORY_HOURS * HOUR);
  if (firstInside === -1) return next.slice(-1);
  return firstInside > 1 ? next.slice(firstInside - 1) : next;
}

/**
 * What the window's account spent per hour over the recorded readings, counting what a new window
 * used since its reset. A reset between two readings hides what the old window spent after the
 * first, so a long gap across a reset reads low. Undefined below a day of readings.
 */
export function measuredSpend(
  samples: readonly SpendSample[],
  window: ServerProviderUsageWindow,
  now: number,
): ServerProviderUsageWindow["recentSpend"] {
  const points = [...samples, sampleOf(window, now)];
  const start = points[0]!;
  const hours = (now - start[0]) / HOUR;
  if (hours < MIN_OBSERVED_HOURS) return undefined;
  let spent = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const next = points[index]!;
    spent += startsNewWindow(previous, next) ? next[1] : Math.max(0, next[1] - previous[1]);
  }
  return { percentPerHour: spent / hours, hours };
}
