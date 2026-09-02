import type {
  OrchestrationThreadActivity,
  OrchestrationUsageLimitHistoryWindow,
} from "@t3tools/contracts";

import { formatElapsedDurationLabel, formatRelativeTimeUntilLabel } from "../timestampFormat";

const WEEKLY_WINDOW_DURATION_MINS = 7 * 24 * 60;
const WEEKDAY_USAGE_WEIGHT = 1;
const WEEKEND_USAGE_WEIGHT = 0.25;
const SLEEP_START_HOUR_LOCAL = 2;
const SLEEP_END_HOUR_LOCAL = 7;
const SLEEP_USAGE_WEIGHT = 0;
const RESET_WINDOW_TOLERANCE_MS = 60 * 1000;
const REGULARIZED_PACE_CONFIDENCE_PERCENT = 50;
const HISTORY_FULL_CONFIDENCE_WINDOWS = 3;
const HISTORY_RECENCY_HALF_LIFE_WINDOWS = 3;
const HISTORY_MAX_PROJECTION_WEIGHT = 0.25;
const USAGE_LIMITS_STALE_AFTER_MS = 10 * 60 * 1000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function hasRateLimitSnapshotFields(value: Record<string, unknown>): boolean {
  return (
    value.primary !== undefined ||
    value.secondary !== undefined ||
    value.individualLimit !== undefined ||
    value.limitId !== undefined ||
    value.limitName !== undefined ||
    value.planType !== undefined ||
    value.rateLimitReachedType !== undefined ||
    value.credits !== undefined ||
    value.windows !== undefined
  );
}

function unwrapRateLimitsPayload(value: unknown): Record<string, unknown> | null {
  let current = asRecord(value);
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current) {
      return null;
    }
    if (hasRateLimitSnapshotFields(current)) {
      return current;
    }
    const nested = asRecord(current.rateLimits);
    if (!nested) {
      return current;
    }
    current = nested;
  }
  return current;
}

function normalizeResetAt(value: unknown): string | null {
  const text = asString(value);
  if (text) {
    return Number.isNaN(new Date(text).getTime()) ? null : text;
  }

  const numeric = asFiniteNumber(value);
  if (numeric === null || numeric <= 0) {
    return null;
  }

  const epochMs = numeric >= 1_000_000_000_000 ? numeric : numeric * 1000;
  const parsed = new Date(epochMs);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export interface UsageLimitWindowSnapshot {
  key?: string | undefined;
  label?: string | undefined;
  usedPercent: number;
  resetsAt: string | null;
  windowDurationMins: number | null;
}

export interface UsageLimitsSnapshot {
  limitId: string | null;
  limitName: string | null;
  planType: string | null;
  rateLimitReachedType: string | null;
  credits: {
    balance: string | null;
    hasCredits: boolean;
    unlimited: boolean;
  } | null;
  primary: UsageLimitWindowSnapshot | null;
  secondary: UsageLimitWindowSnapshot | null;
  windows?: ReadonlyArray<UsageLimitWindowSnapshot> | undefined;
  history?: ReadonlyArray<OrchestrationUsageLimitHistoryWindow> | undefined;
  updatedAt: string;
}

export interface UsageLimitsActivitySource {
  provider: string | null;
  providerInstanceId?: string | null | undefined;
  usageLimits?: ReadonlyArray<UsageLimitsSnapshot> | null | undefined;
  usageHistory?: ReadonlyArray<OrchestrationUsageLimitHistoryWindow> | null | undefined;
  activities?: ReadonlyArray<OrchestrationThreadActivity> | null | undefined;
}

export interface UsageLimitForecastOptions {
  /** Used by walk-forward evaluation to compare history against the regularized baseline. */
  historyMaxProjectionWeight?: number | undefined;
}

export type UsageLimitWindowStatus = "ok" | "atRisk" | "reached" | "unknown";

export type UsageDepletionForecast =
  | { readonly kind: "reached" }
  | {
      readonly kind: "beforeReset";
      readonly estimatedAtMs: number;
      readonly range: {
        readonly earliestAtMs: number;
        readonly latestAtMs: number | null;
      } | null;
    }
  | { readonly kind: "untilReset" }
  | { readonly kind: "unknown" };

export interface DerivedUsageLimitWindowSnapshot extends UsageLimitWindowSnapshot {
  durationLabel: string | null;
  resetRelativeLabel: string | null;
  resetAbsoluteLabel: string | null;
  // Projection elapsed time can differ from wall-clock time because local sleep
  // hours and low-usage weekend hours are discounted.
  elapsedPercent: number | null;
  projectedPercentAtReset: number | null;
  projectedPercentRange: { readonly low: number; readonly high: number } | null;
  projectionBasis: "history" | "regularized" | null;
  projectionConfidence: "early" | "established" | null;
  historicalWindowCount: number;
  depletionForecast: UsageDepletionForecast;
  status: UsageLimitWindowStatus;
  isStale: boolean;
  resetExpired: boolean;
}

export interface DerivedUsageLimitsSnapshot extends Omit<
  UsageLimitsSnapshot,
  "primary" | "secondary" | "windows"
> {
  primary: DerivedUsageLimitWindowSnapshot | null;
  secondary: DerivedUsageLimitWindowSnapshot | null;
  windows: ReadonlyArray<DerivedUsageLimitWindowSnapshot>;
  compactWindow: "primary" | "secondary" | null;
  compactWindowStatus: UsageLimitWindowStatus | null;
  isStale: boolean;
  updatedRelativeLabel: string | null;
}

interface UsageLimitsSnapshotCandidate {
  snapshot: UsageLimitsSnapshot;
  updatedAtMs: number;
}

interface UsageLimitWindowCandidate {
  window: UsageLimitWindowSnapshot;
  updatedAtMs: number;
  resetMs: number | null;
}

function normalizeWindow(value: unknown): UsageLimitWindowSnapshot | null {
  const record = asRecord(value);
  const usedPercent = asFiniteNumber(record?.usedPercent);
  if (usedPercent === null) {
    return null;
  }

  const key = asString(record?.key);
  const label = asString(record?.label);
  return {
    ...(key ? { key } : {}),
    ...(label ? { label } : {}),
    usedPercent,
    resetsAt: normalizeResetAt(record?.resetsAt),
    windowDurationMins: asFiniteNumber(record?.windowDurationMins),
  };
}

function normalizeIndividualLimitWindow(value: unknown): UsageLimitWindowSnapshot | null {
  const record = asRecord(value);
  const remainingPercent = asFiniteNumber(record?.remainingPercent);
  if (remainingPercent === null) {
    return null;
  }

  return {
    usedPercent: Math.max(0, Math.min(100, 100 - remainingPercent)),
    resetsAt: normalizeResetAt(record?.resetsAt),
    windowDurationMins: null,
  };
}

function selectSecondaryWindow(
  secondary: UsageLimitWindowSnapshot | null,
  individualLimit: UsageLimitWindowSnapshot | null,
): UsageLimitWindowSnapshot | null {
  if (!secondary) {
    return individualLimit;
  }
  if (secondary.usedPercent === 0 && individualLimit && individualLimit.usedPercent > 0) {
    return individualLimit;
  }
  return secondary;
}

function parseTimestampMs(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatWindowDurationLabel(windowDurationMins: number | null): string | null {
  if (windowDurationMins === null || windowDurationMins <= 0) {
    return null;
  }
  if (windowDurationMins % (60 * 24 * 7) === 0) {
    return `${windowDurationMins / (60 * 24 * 7)}w`;
  }
  if (windowDurationMins % (60 * 24) === 0) {
    return `${windowDurationMins / (60 * 24)}d`;
  }
  if (windowDurationMins % 60 === 0) {
    return `${windowDurationMins / 60}h`;
  }

  const hours = Math.floor(windowDurationMins / 60);
  const minutes = windowDurationMins % 60;
  if (hours <= 0) {
    return `${minutes}m`;
  }
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function formatAbsoluteResetLabel(isoDate: string | null): string | null {
  if (!isoDate) {
    return null;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(isoDate));
}

function isWeekendLocal(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

function isSleepTimeLocal(date: Date): boolean {
  const hour = date.getHours();
  if (SLEEP_START_HOUR_LOCAL < SLEEP_END_HOUR_LOCAL) {
    return hour >= SLEEP_START_HOUR_LOCAL && hour < SLEEP_END_HOUR_LOCAL;
  }
  return hour >= SLEEP_START_HOUR_LOCAL || hour < SLEEP_END_HOUR_LOCAL;
}

function localBoundaryMs(date: Date, dayOffset: number, hour: number): number {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + dayOffset,
    hour,
    0,
    0,
    0,
  ).getTime();
}

function nextLocalBoundaryMs(date: Date): number {
  const cursorMs = date.getTime();
  return Math.min(
    ...[
      localBoundaryMs(date, 0, 0),
      localBoundaryMs(date, 0, SLEEP_START_HOUR_LOCAL),
      localBoundaryMs(date, 0, SLEEP_END_HOUR_LOCAL),
      localBoundaryMs(date, 1, 0),
    ].filter((boundaryMs) => boundaryMs > cursorMs),
  );
}

function deriveUsageWeight(date: Date, windowDurationMins: number): number {
  if (isSleepTimeLocal(date)) {
    return SLEEP_USAGE_WEIGHT;
  }

  if (windowDurationMins === WEEKLY_WINDOW_DURATION_MINS && isWeekendLocal(date)) {
    return WEEKEND_USAGE_WEIGHT;
  }

  return WEEKDAY_USAGE_WEIGHT;
}

function deriveExpectedUsageDurationMs(
  startMs: number,
  endMs: number,
  windowDurationMins: number,
): number {
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs ||
    !Number.isFinite(windowDurationMins) ||
    windowDurationMins <= 0
  ) {
    return 0;
  }

  let cursorMs = startMs;
  let expectedUsageMs = 0;

  while (cursorMs < endMs) {
    const cursorDate = new Date(cursorMs);
    const nextBoundaryMs = Math.min(nextLocalBoundaryMs(cursorDate), endMs);
    const weight = deriveUsageWeight(cursorDate, windowDurationMins);
    expectedUsageMs += (nextBoundaryMs - cursorMs) * weight;
    cursorMs = nextBoundaryMs;
  }

  return expectedUsageMs;
}

function deriveExpectedUsageTimestampMs(
  startMs: number,
  endMs: number,
  windowDurationMins: number,
  targetExpectedUsageMs: number,
): number | null {
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs ||
    !Number.isFinite(targetExpectedUsageMs) ||
    targetExpectedUsageMs < 0
  ) {
    return null;
  }

  let cursorMs = startMs;
  let remainingExpectedUsageMs = targetExpectedUsageMs;

  while (cursorMs < endMs) {
    const cursorDate = new Date(cursorMs);
    const nextBoundaryMs = Math.min(nextLocalBoundaryMs(cursorDate), endMs);
    const weight = deriveUsageWeight(cursorDate, windowDurationMins);
    const segmentExpectedUsageMs = (nextBoundaryMs - cursorMs) * weight;

    if (weight > 0 && remainingExpectedUsageMs <= segmentExpectedUsageMs) {
      return cursorMs + remainingExpectedUsageMs / weight;
    }

    remainingExpectedUsageMs -= segmentExpectedUsageMs;
    cursorMs = nextBoundaryMs;
  }

  return remainingExpectedUsageMs <= 1 ? endMs : null;
}

function deriveExpectedUsageElapsedPercent(
  resetMs: number,
  durationMs: number,
  windowDurationMins: number,
  nowMs: number,
): number | null {
  const windowStartMs = resetMs - durationMs;
  const effectiveNowMs = Math.min(Math.max(nowMs, windowStartMs), resetMs);
  const expectedTotalMs = deriveExpectedUsageDurationMs(windowStartMs, resetMs, windowDurationMins);
  if (expectedTotalMs <= 0) {
    return null;
  }

  const expectedElapsedMs = deriveExpectedUsageDurationMs(
    windowStartMs,
    effectiveNowMs,
    windowDurationMins,
  );
  if (expectedElapsedMs < 0) {
    return null;
  }

  return Math.max(0, Math.min(100, (expectedElapsedMs / expectedTotalMs) * 100));
}

function deriveProjectionElapsedPercent(
  window: UsageLimitWindowSnapshot,
  nowMs: number,
): number | null {
  if (!window.resetsAt || !window.windowDurationMins || window.windowDurationMins <= 0) {
    return null;
  }

  const resetMs = new Date(window.resetsAt).getTime();
  if (Number.isNaN(resetMs)) {
    return null;
  }

  const durationMs = window.windowDurationMins * 60 * 1000;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }

  return deriveExpectedUsageElapsedPercent(resetMs, durationMs, window.windowDurationMins, nowMs);
}

function deriveProjectedPercentAtReset(
  usedPercent: number,
  elapsedPercent: number | null,
): number | null {
  if (elapsedPercent === null || elapsedPercent <= 0) {
    return null;
  }
  const linearProjection = (usedPercent / elapsedPercent) * 100;
  const confidence = Math.min(1, elapsedPercent / REGULARIZED_PACE_CONFIDENCE_PERCENT);
  return 100 + (linearProjection - 100) * confidence;
}

function weightedMedian(
  values: ReadonlyArray<{ readonly value: number; readonly weight: number }>,
): number {
  const sorted = values.toSorted((left, right) => left.value - right.value);
  const midpoint = sorted.reduce((total, item) => total + item.weight, 0) / 2;
  let accumulated = 0;
  for (const item of sorted) {
    accumulated += item.weight;
    if (accumulated >= midpoint) {
      return item.value;
    }
  }
  return sorted.at(-1)?.value ?? 0;
}

function deriveHistoricalProjection(input: {
  readonly window: UsageLimitWindowSnapshot;
  readonly history: ReadonlyArray<OrchestrationUsageLimitHistoryWindow>;
  readonly elapsedPercent: number | null;
  readonly regularizedProjection: number | null;
  readonly historyMaxProjectionWeight: number;
}): {
  readonly projectedPercentAtReset: number | null;
  readonly projectedPercentRange: { readonly low: number; readonly high: number } | null;
  readonly projectionBasis: "history" | "regularized" | null;
  readonly projectionConfidence: "early" | "established" | null;
  readonly historicalWindowCount: number;
} {
  const durationMins = input.window.windowDurationMins;
  const resetMs = parseTimestampMs(input.window.resetsAt);
  if (
    !durationMins ||
    durationMins <= 0 ||
    resetMs === null ||
    input.elapsedPercent === null ||
    input.elapsedPercent >= 100
  ) {
    return {
      projectedPercentAtReset: input.regularizedProjection,
      projectedPercentRange: null,
      projectionBasis: input.regularizedProjection === null ? null : "regularized",
      projectionConfidence: input.regularizedProjection === null ? null : "early",
      historicalWindowCount: 0,
    };
  }

  const elapsedPercent = input.elapsedPercent;
  const durationMs = durationMins * 60 * 1000;
  const windowStartMs = resetMs - durationMs;
  const completed = input.history
    .filter(
      (window) =>
        window.windowKey === input.window.key &&
        window.windowDurationMins === durationMins &&
        Date.parse(window.resetsAt) <= windowStartMs + RESET_WINDOW_TOLERANCE_MS &&
        window.points.length > 0,
    )
    .toSorted((left, right) => Date.parse(left.resetsAt) - Date.parse(right.resetsAt));

  const estimates = completed.flatMap((window, index) => {
    const historicalResetMs = Date.parse(window.resetsAt);
    const historicalStartMs = historicalResetMs - durationMs;
    const historicalExpectedDurationMs = deriveExpectedUsageDurationMs(
      historicalStartMs,
      historicalResetMs,
      durationMins,
    );
    const historicalCutoffMs = deriveExpectedUsageTimestampMs(
      historicalStartMs,
      historicalResetMs,
      durationMins,
      historicalExpectedDurationMs * (elapsedPercent / 100),
    );
    if (historicalCutoffMs === null) {
      return [];
    }
    const points = window.points
      .filter((point) => Number.isFinite(Date.parse(point.observedAt)))
      .toSorted((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
    const finalPoint = points.at(-1);
    if (finalPoint === undefined) {
      return [];
    }
    const usedAtCutoff = points.findLast(
      (point) => Date.parse(point.observedAt) <= historicalCutoffMs,
    )?.usedPercent;
    if (usedAtCutoff === undefined) {
      return [];
    }

    // A reset can interrupt a window days before its advertised end. Its
    // observed prefix is still useful, but the missing tail is not zero usage.
    // Fill only that unobserved tail with the regularized forecast.
    const finalObservedAtMs = Date.parse(finalPoint.observedAt);
    const observedCoverageEnd =
      finalPoint.usedPercent >= 100 ||
      finalObservedAtMs >= historicalResetMs - RESET_WINDOW_TOLERANCE_MS
        ? 100
        : deriveExpectedUsageElapsedPercent(
            historicalResetMs,
            durationMs,
            durationMins,
            finalObservedAtMs,
          );
    if (observedCoverageEnd === null || observedCoverageEnd <= elapsedPercent) {
      return [];
    }
    const coverage = Math.min(1, (observedCoverageEnd - elapsedPercent) / (100 - elapsedPercent));
    const observedRemaining = Math.max(0, finalPoint.usedPercent - usedAtCutoff);
    const regularizedRemaining = Math.max(
      0,
      (input.regularizedProjection ?? input.window.usedPercent) - input.window.usedPercent,
    );
    const age = completed.length - index - 1;
    return [
      {
        value: input.window.usedPercent + observedRemaining + regularizedRemaining * (1 - coverage),
        coverage,
        weight: 2 ** (-age / HISTORY_RECENCY_HALF_LIFE_WINDOWS) * coverage,
      },
    ];
  });

  if (estimates.length === 0) {
    return {
      projectedPercentAtReset: input.regularizedProjection,
      projectedPercentRange: null,
      projectionBasis: input.regularizedProjection === null ? null : "regularized",
      projectionConfidence: input.regularizedProjection === null ? null : "early",
      historicalWindowCount: 0,
    };
  }

  const historicalProjection = weightedMedian(estimates);
  const effectiveHistoricalWindows = estimates.reduce(
    (total, estimate) => total + estimate.coverage,
    0,
  );
  const historyCoverageConfidence = Math.min(
    1,
    effectiveHistoricalWindows / HISTORY_FULL_CONFIDENCE_WINDOWS,
  );
  const historyProjectionWeight = Math.min(
    input.historyMaxProjectionWeight,
    historyCoverageConfidence,
  );
  const blendWithRegularizedProjection = (historicalValue: number) =>
    input.regularizedProjection === null
      ? historicalValue
      : input.regularizedProjection * (1 - historyProjectionWeight) +
        historicalValue * historyProjectionWeight;
  const projectedPercentAtReset = blendWithRegularizedProjection(historicalProjection);
  const estimateValues = estimates.map((estimate) => estimate.value);

  return {
    projectedPercentAtReset,
    projectedPercentRange:
      effectiveHistoricalWindows >= HISTORY_FULL_CONFIDENCE_WINDOWS
        ? {
            low: blendWithRegularizedProjection(Math.min(...estimateValues)),
            high: blendWithRegularizedProjection(Math.max(...estimateValues)),
          }
        : null,
    projectionBasis: "history",
    projectionConfidence: historyCoverageConfidence >= 1 ? "established" : "early",
    historicalWindowCount: estimates.length,
  };
}

function deriveWindowStatus(input: {
  usedPercent: number;
  projectedPercentAtReset: number | null;
  rateLimitReachedType: string | null;
}): UsageLimitWindowStatus {
  if (input.rateLimitReachedType !== null || input.usedPercent >= 100) {
    return "reached";
  }
  if (input.projectedPercentAtReset === null) {
    return "unknown";
  }
  return input.projectedPercentAtReset >= 100 ? "atRisk" : "ok";
}

function deriveEstimatedDepletionAtMs(input: {
  readonly window: UsageLimitWindowSnapshot;
  readonly projectedPercentAtReset: number;
  readonly nowMs: number;
}): number | null {
  const resetMs = parseTimestampMs(input.window.resetsAt);
  const durationMins = input.window.windowDurationMins;
  if (
    resetMs === null ||
    !durationMins ||
    durationMins <= 0 ||
    input.window.usedPercent >= 100 ||
    input.projectedPercentAtReset <= 100
  ) {
    return null;
  }

  const durationMs = durationMins * 60 * 1000;
  const windowStartMs = resetMs - durationMs;
  const effectiveNowMs = Math.min(Math.max(input.nowMs, windowStartMs), resetMs);
  const expectedRemainingMs = deriveExpectedUsageDurationMs(effectiveNowMs, resetMs, durationMins);
  const projectedRemainingPercent = input.projectedPercentAtReset - input.window.usedPercent;
  if (expectedRemainingMs <= 0 || projectedRemainingPercent <= 0) {
    return null;
  }

  const fractionUntilDepletion = (100 - input.window.usedPercent) / projectedRemainingPercent;
  if (fractionUntilDepletion < 0 || fractionUntilDepletion >= 1) {
    return null;
  }

  return deriveExpectedUsageTimestampMs(
    effectiveNowMs,
    resetMs,
    durationMins,
    expectedRemainingMs * fractionUntilDepletion,
  );
}

function deriveDepletionForecast(input: {
  readonly window: UsageLimitWindowSnapshot;
  readonly projectedPercentAtReset: number | null;
  readonly projectedPercentRange: { readonly low: number; readonly high: number } | null;
  readonly status: UsageLimitWindowStatus;
  readonly nowMs: number;
}): UsageDepletionForecast {
  if (input.status === "reached") {
    return { kind: "reached" };
  }
  if (input.status === "unknown" || input.projectedPercentAtReset === null) {
    return { kind: "unknown" };
  }
  if (input.projectedPercentAtReset <= 100) {
    return { kind: "untilReset" };
  }

  const estimatedAtMs = deriveEstimatedDepletionAtMs({
    window: input.window,
    projectedPercentAtReset: input.projectedPercentAtReset,
    nowMs: input.nowMs,
  });
  if (estimatedAtMs === null) {
    return { kind: "unknown" };
  }

  const earliestAtMs = input.projectedPercentRange
    ? deriveEstimatedDepletionAtMs({
        window: input.window,
        projectedPercentAtReset: input.projectedPercentRange.high,
        nowMs: input.nowMs,
      })
    : null;
  const latestAtMs = input.projectedPercentRange
    ? deriveEstimatedDepletionAtMs({
        window: input.window,
        projectedPercentAtReset: input.projectedPercentRange.low,
        nowMs: input.nowMs,
      })
    : null;

  return {
    kind: "beforeReset",
    estimatedAtMs,
    range:
      earliestAtMs === null
        ? null
        : {
            earliestAtMs,
            latestAtMs,
          },
  };
}

function deriveWindowDisplay(
  window: UsageLimitWindowSnapshot | null,
  rateLimitReachedType: string | null,
  history: ReadonlyArray<OrchestrationUsageLimitHistoryWindow>,
  observedAtMs: number,
  nowMs: number,
  isStale: boolean,
  options: UsageLimitForecastOptions,
): DerivedUsageLimitWindowSnapshot | null {
  if (!window) {
    return null;
  }

  const resetMs = parseTimestampMs(window.resetsAt);
  const resetExpired = resetMs !== null && resetMs <= nowMs;
  const elapsedPercent = deriveProjectionElapsedPercent(window, observedAtMs);
  const regularizedProjection = deriveProjectedPercentAtReset(window.usedPercent, elapsedPercent);
  const projection = deriveHistoricalProjection({
    window,
    history,
    elapsedPercent,
    regularizedProjection,
    historyMaxProjectionWeight: Math.max(
      0,
      Math.min(1, options.historyMaxProjectionWeight ?? HISTORY_MAX_PROJECTION_WEIGHT),
    ),
  });
  const status =
    isStale || resetExpired
      ? "unknown"
      : deriveWindowStatus({
          usedPercent: window.usedPercent,
          projectedPercentAtReset: projection.projectedPercentAtReset,
          rateLimitReachedType,
        });

  return {
    ...window,
    durationLabel: formatWindowDurationLabel(window.windowDurationMins),
    resetRelativeLabel: window.resetsAt
      ? formatRelativeTimeUntilLabel(window.resetsAt, nowMs)
      : null,
    resetAbsoluteLabel: formatAbsoluteResetLabel(window.resetsAt),
    elapsedPercent,
    ...projection,
    depletionForecast: deriveDepletionForecast({
      window,
      projectedPercentAtReset: projection.projectedPercentAtReset,
      projectedPercentRange: projection.projectedPercentRange,
      status,
      nowMs: observedAtMs,
    }),
    status,
    isStale,
    resetExpired,
  };
}

function activityToUsageLimitsSnapshot(
  activity: OrchestrationThreadActivity,
): UsageLimitsSnapshot | null {
  if (!activity || activity.kind !== "account.rate-limits.updated") {
    return null;
  }

  const payload = unwrapRateLimitsPayload(activity.payload);
  const primary = normalizeWindow(payload?.primary);
  const secondary = selectSecondaryWindow(
    normalizeWindow(payload?.secondary),
    normalizeIndividualLimitWindow(payload?.individualLimit),
  );
  const windows = Array.isArray(payload?.windows)
    ? payload.windows.flatMap((window) => {
        const normalized = normalizeWindow(window);
        return normalized ? [normalized] : [];
      })
    : [];
  if (primary === null && secondary === null && windows.length === 0) {
    return null;
  }

  const creditsRecord = asRecord(payload?.credits);
  const hasCredits = asBoolean(creditsRecord?.hasCredits);
  const unlimited = asBoolean(creditsRecord?.unlimited);

  return {
    limitId: asString(payload?.limitId),
    limitName: asString(payload?.limitName),
    planType: asString(payload?.planType),
    rateLimitReachedType: asString(payload?.rateLimitReachedType),
    credits:
      hasCredits !== null && unlimited !== null
        ? {
            balance: asString(creditsRecord?.balance),
            hasCredits,
            unlimited,
          }
        : null,
    primary,
    secondary,
    ...(windows.length > 0 ? { windows } : {}),
    updatedAt: activity.createdAt,
  };
}

function collectUsageLimitsSnapshotCandidates(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): Array<UsageLimitsSnapshotCandidate> {
  const candidates: Array<UsageLimitsSnapshotCandidate> = [];

  for (const activity of activities) {
    if (!activity || activity.kind !== "account.rate-limits.updated") {
      continue;
    }

    const updatedAtMs = Date.parse(activity.createdAt);
    if (!Number.isFinite(updatedAtMs)) {
      continue;
    }

    const snapshot = activityToUsageLimitsSnapshot(activity);
    if (!snapshot) {
      continue;
    }

    candidates.push({ snapshot, updatedAtMs });
  }

  return candidates;
}

function collectUsageLimitsSnapshotCandidatesFromSnapshots(
  snapshots: ReadonlyArray<UsageLimitsSnapshot>,
): Array<UsageLimitsSnapshotCandidate> {
  const candidates: Array<UsageLimitsSnapshotCandidate> = [];
  for (const snapshot of snapshots) {
    const updatedAtMs = Date.parse(snapshot.updatedAt);
    if (!Number.isFinite(updatedAtMs)) {
      continue;
    }
    candidates.push({ snapshot, updatedAtMs });
  }
  return candidates;
}

function makeWindowCandidate(
  candidate: UsageLimitsSnapshotCandidate,
  window: UsageLimitWindowSnapshot | null,
): UsageLimitWindowCandidate | null {
  if (!window) {
    return null;
  }

  return {
    window,
    updatedAtMs: candidate.updatedAtMs,
    resetMs: parseTimestampMs(window.resetsAt),
  };
}

function isWindowCandidateBetter(
  candidate: UsageLimitWindowCandidate,
  current: UsageLimitWindowCandidate,
): boolean {
  if (candidate.resetMs !== null && current.resetMs !== null) {
    if (candidate.resetMs > current.resetMs + RESET_WINDOW_TOLERANCE_MS) {
      return true;
    }
    if (current.resetMs > candidate.resetMs + RESET_WINDOW_TOLERANCE_MS) {
      return false;
    }

    if (candidate.window.usedPercent !== current.window.usedPercent) {
      return candidate.window.usedPercent > current.window.usedPercent;
    }

    return candidate.updatedAtMs >= current.updatedAtMs;
  }

  if (candidate.resetMs !== null && current.resetMs === null) {
    return true;
  }

  if (candidate.resetMs === null && current.resetMs !== null) {
    return false;
  }

  return candidate.updatedAtMs >= current.updatedAtMs;
}

function selectBestWindowCandidate(
  candidates: ReadonlyArray<UsageLimitWindowCandidate>,
): UsageLimitWindowCandidate | null {
  let bestCandidate: UsageLimitWindowCandidate | null = null;

  for (const candidate of candidates) {
    if (!bestCandidate || isWindowCandidateBetter(candidate, bestCandidate)) {
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

function deriveLatestMetadataCandidate(
  candidates: ReadonlyArray<UsageLimitsSnapshotCandidate>,
): UsageLimitsSnapshotCandidate | null {
  let latestCandidate: UsageLimitsSnapshotCandidate | null = null;

  for (const candidate of candidates) {
    if (!latestCandidate || candidate.updatedAtMs >= latestCandidate.updatedAtMs) {
      latestCandidate = candidate;
    }
  }

  return latestCandidate;
}

function aggregateUsageLimitsSnapshots(
  candidates: ReadonlyArray<UsageLimitsSnapshotCandidate>,
  history: ReadonlyArray<OrchestrationUsageLimitHistoryWindow> = [],
): UsageLimitsSnapshot | null {
  const metadataCandidate = deriveLatestMetadataCandidate(candidates);
  if (!metadataCandidate) {
    return null;
  }

  const primaryCandidates: Array<UsageLimitWindowCandidate> = [];
  const secondaryCandidates: Array<UsageLimitWindowCandidate> = [];
  const windowCandidates = new Map<string, Array<UsageLimitWindowCandidate>>();

  for (const candidate of candidates) {
    const primary = makeWindowCandidate(candidate, candidate.snapshot.primary);
    if (primary) {
      primaryCandidates.push(primary);
    }

    const secondary = makeWindowCandidate(candidate, candidate.snapshot.secondary);
    if (secondary) {
      secondaryCandidates.push(secondary);
    }

    for (const [index, window] of (candidate.snapshot.windows ?? []).entries()) {
      const normalized = makeWindowCandidate(candidate, window);
      if (!normalized) continue;
      const key = window.key ?? `legacy-window-${index}`;
      const entries = windowCandidates.get(key) ?? [];
      entries.push(normalized);
      windowCandidates.set(key, entries);
    }
  }

  const primary = selectBestWindowCandidate(primaryCandidates);
  const secondary = selectBestWindowCandidate(secondaryCandidates);
  const windows = Array.from(windowCandidates.values()).flatMap((entries) => {
    const selected = selectBestWindowCandidate(entries);
    return selected ? [selected] : [];
  });
  if (!primary && !secondary && windows.length === 0) {
    return null;
  }

  return {
    ...metadataCandidate.snapshot,
    primary: primary?.window ?? null,
    secondary: secondary?.window ?? null,
    ...(windows.length > 0 ? { windows: windows.map((entry) => entry.window) } : {}),
    history,
    updatedAt: new Date(
      Math.max(
        metadataCandidate.updatedAtMs,
        primary?.updatedAtMs ?? Number.NEGATIVE_INFINITY,
        secondary?.updatedAtMs ?? Number.NEGATIVE_INFINITY,
        ...windows.map((entry) => entry.updatedAtMs),
      ),
    ).toISOString(),
  };
}

export function deriveLatestUsageLimitsSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): UsageLimitsSnapshot | null {
  return aggregateUsageLimitsSnapshots(collectUsageLimitsSnapshotCandidates(activities));
}

export function deriveLatestUsageLimitsSnapshotForSources(
  sources: ReadonlyArray<UsageLimitsActivitySource>,
  provider: string | null | undefined = null,
  providerInstanceId: string | null | undefined = null,
): UsageLimitsSnapshot | null {
  const candidates: Array<UsageLimitsSnapshotCandidate> = [];
  const history: Array<OrchestrationUsageLimitHistoryWindow> = [];

  for (const source of sources) {
    if (
      (provider && source.provider !== provider) ||
      (providerInstanceId && source.providerInstanceId !== providerInstanceId)
    ) {
      continue;
    }

    candidates.push(
      ...collectUsageLimitsSnapshotCandidatesFromSnapshots(source.usageLimits ?? []),
      ...collectUsageLimitsSnapshotCandidates(source.activities ?? []),
    );
    history.push(...(source.usageHistory ?? []));
  }

  return aggregateUsageLimitsSnapshots(candidates, history);
}

export function deriveDisplayedUsageLimitsSnapshot(
  snapshot: UsageLimitsSnapshot | null,
  nowMs: number = Date.now(),
  options: UsageLimitForecastOptions = {},
): DerivedUsageLimitsSnapshot | null {
  if (!snapshot) {
    return null;
  }

  const updatedAtMs = Date.parse(snapshot.updatedAt);
  const hasValidUpdatedAt = Number.isFinite(updatedAtMs);
  const observedAtMs = hasValidUpdatedAt ? Math.min(updatedAtMs, nowMs) : nowMs;
  const isStale = !hasValidUpdatedAt || nowMs - observedAtMs >= USAGE_LIMITS_STALE_AFTER_MS;
  const elapsedLabel = hasValidUpdatedAt
    ? formatElapsedDurationLabel(snapshot.updatedAt, nowMs)
    : "";
  const updatedRelativeLabel = elapsedLabel
    ? elapsedLabel === "just now"
      ? "Updated just now"
      : `Updated ${elapsedLabel} ago`
    : null;
  const history = snapshot.history ?? [];
  const primary = deriveWindowDisplay(
    snapshot.primary,
    snapshot.rateLimitReachedType,
    history,
    observedAtMs,
    nowMs,
    isStale,
    options,
  );
  const secondary = deriveWindowDisplay(
    snapshot.secondary,
    snapshot.rateLimitReachedType,
    history,
    observedAtMs,
    nowMs,
    isStale,
    options,
  );
  const windows = (snapshot.windows ?? []).flatMap((window) => {
    const derived = deriveWindowDisplay(
      window,
      snapshot.rateLimitReachedType,
      history,
      observedAtMs,
      nowMs,
      isStale,
      options,
    );
    return derived ? [derived] : [];
  });
  const compactWindow = primary ? "primary" : secondary ? "secondary" : null;
  const compactWindowStatus =
    compactWindow === "primary"
      ? (primary?.status ?? null)
      : compactWindow === "secondary"
        ? (secondary?.status ?? null)
        : null;

  if (compactWindow === null) {
    return null;
  }

  return {
    ...snapshot,
    primary,
    secondary,
    windows,
    compactWindow,
    compactWindowStatus,
    isStale,
    updatedRelativeLabel,
  };
}
