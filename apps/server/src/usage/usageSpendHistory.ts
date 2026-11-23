import type { ServerProviderUsageWindow } from "@t3tools/contracts";

const HOUR = 3_600_000;
/** Readings of a window that stopped reporting this long ago belong to a removed account or hub. */
export const ABANDONED_HISTORY_HOURS = 8 * 24;
// Readings come at least hourly while T3 reads the hub, so a longer gap means nobody was reading.
const MAX_GAP_MS = 2 * HOUR;

// A full window covers its usage rhythm: a week's pace measured over a weekend reads near zero.
function lookbackMs(window: ServerProviderUsageWindow): number | null {
  return window.windowDurationMins ? window.windowDurationMins * 60_000 : null;
}

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

/**
 * Adds a reading taken at `at` when it changed, or hourly so quiet hours count as observed. A
 * reading no newer than the last one is a kept-over read that failed, and adds nothing.
 */
export function recordSpendSample(
  samples: readonly SpendSample[],
  window: ServerProviderUsageWindow,
  at: number,
): readonly SpendSample[] {
  const sample = sampleOf(window, at);
  const last = samples.at(-1);
  if (last && at <= last[0]) return samples;
  const unchanged = last && last[1] === sample[1] && !startsNewWindow(last, sample);
  const next = unchanged && at - last[0] < HOUR ? samples : [...samples, sample];
  const oldest = at - (lookbackMs(window) ?? ABANDONED_HISTORY_HOURS * HOUR) - MAX_GAP_MS;
  return next[0]![0] >= oldest ? next : next.filter(([sampleAt]) => sampleAt >= oldest);
}

/**
 * What the window's account spent per hour over the last window length of readings, counting what
 * a new window used since its reset. A gap across a reset hides what the old window spent last, so
 * it counts as unobserved. `hours` says how much of that length was observed; clients decide when
 * it is enough.
 */
export function measuredSpend(
  samples: readonly SpendSample[],
  window: ServerProviderUsageWindow,
  at: number,
): ServerProviderUsageWindow["recentSpend"] {
  const lookback = lookbackMs(window);
  if (lookback === null) return undefined;
  const last = samples.at(-1);
  const points = last && at <= last[0] ? samples : [...samples, sampleOf(window, at)];
  const from = at - lookback;
  let spent = 0;
  let observedMs = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const next = points[index]!;
    const duration = next[0] - previous[0];
    const reset = startsNewWindow(previous, next);
    if (next[0] <= from || (reset && duration > MAX_GAP_MS)) continue;
    // Readings come hourly when nothing changes, so the interval across `from` counts its share.
    const share = previous[0] < from ? (next[0] - from) / duration : 1;
    spent += (reset ? next[1] : Math.max(0, next[1] - previous[1])) * share;
    observedMs += duration * share;
  }
  const hours = observedMs / HOUR;
  return hours > 0 ? { percentPerHour: spent / hours, hours } : undefined;
}
