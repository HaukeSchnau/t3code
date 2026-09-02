import type { OrchestrationUsageLimitHistoryWindow } from "@t3tools/contracts";

import { deriveDisplayedUsageLimitsSnapshot, type UsageLimitsSnapshot } from "./usageLimits";

const RESET_COMPLETION_TOLERANCE_MS = 60 * 1000;

export interface UsageLimitForecastMetrics {
  predictionCount: number;
  meanAbsoluteError: number | null;
  meanSignedError: number | null;
  riskDecisionAccuracy: number | null;
  jumpCount: number;
  meanAbsoluteJump: number | null;
  maxAbsoluteJump: number | null;
}

export interface UsageLimitForecastEvaluation {
  windowCount: number;
  evaluatedWindowCount: number;
  earlyResetWindowCount: number;
  activeWindowCount: number;
  unobservedCompletionWindowCount: number;
  regularized: UsageLimitForecastMetrics;
  current: UsageLimitForecastMetrics;
  meanAbsoluteErrorImprovement: number | null;
  meanAbsoluteErrorImprovementPercent: number | null;
}

export interface UsageLimitForecastEvaluationGroup extends UsageLimitForecastEvaluation {
  windowKey: string | null;
  windowDurationMins: number;
}

export interface UsageLimitForecastEvaluationReport {
  overall: UsageLimitForecastEvaluation;
  groups: ReadonlyArray<UsageLimitForecastEvaluationGroup>;
}

interface ForecastSample {
  readonly actual: number;
  readonly forecast: number;
  readonly jumpFromPrevious: number | null;
}

interface EvaluationAccumulator {
  windowCount: number;
  evaluatedWindowCount: number;
  earlyResetWindowCount: number;
  activeWindowCount: number;
  unobservedCompletionWindowCount: number;
  regularized: Array<ForecastSample>;
  current: Array<ForecastSample>;
}

function makeAccumulator(): EvaluationAccumulator {
  return {
    windowCount: 0,
    evaluatedWindowCount: 0,
    earlyResetWindowCount: 0,
    activeWindowCount: 0,
    unobservedCompletionWindowCount: 0,
    regularized: [],
    current: [],
  };
}

function addAccumulator(target: EvaluationAccumulator, source: EvaluationAccumulator): void {
  target.windowCount += source.windowCount;
  target.evaluatedWindowCount += source.evaluatedWindowCount;
  target.earlyResetWindowCount += source.earlyResetWindowCount;
  target.activeWindowCount += source.activeWindowCount;
  target.unobservedCompletionWindowCount += source.unobservedCompletionWindowCount;
  target.regularized.push(...source.regularized);
  target.current.push(...source.current);
}

function mean(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function deriveMetrics(samples: ReadonlyArray<ForecastSample>): UsageLimitForecastMetrics {
  const jumps = samples.flatMap((sample) =>
    sample.jumpFromPrevious === null ? [] : [sample.jumpFromPrevious],
  );
  return {
    predictionCount: samples.length,
    meanAbsoluteError: mean(samples.map((sample) => Math.abs(sample.forecast - sample.actual))),
    meanSignedError: mean(samples.map((sample) => sample.forecast - sample.actual)),
    riskDecisionAccuracy: mean(
      samples.map((sample) => Number(sample.forecast >= 100 === sample.actual >= 100)),
    ),
    jumpCount: jumps.length,
    meanAbsoluteJump: mean(jumps),
    maxAbsoluteJump: jumps.length === 0 ? null : Math.max(...jumps),
  };
}

function finishAccumulator(accumulator: EvaluationAccumulator): UsageLimitForecastEvaluation {
  const regularized = deriveMetrics(accumulator.regularized);
  const current = deriveMetrics(accumulator.current);
  const improvement =
    regularized.meanAbsoluteError === null || current.meanAbsoluteError === null
      ? null
      : regularized.meanAbsoluteError - current.meanAbsoluteError;

  return {
    windowCount: accumulator.windowCount,
    evaluatedWindowCount: accumulator.evaluatedWindowCount,
    earlyResetWindowCount: accumulator.earlyResetWindowCount,
    activeWindowCount: accumulator.activeWindowCount,
    unobservedCompletionWindowCount: accumulator.unobservedCompletionWindowCount,
    regularized,
    current,
    meanAbsoluteErrorImprovement: improvement,
    meanAbsoluteErrorImprovementPercent:
      improvement === null || !regularized.meanAbsoluteError
        ? null
        : (improvement / regularized.meanAbsoluteError) * 100,
  };
}

function makeReplaySnapshot(
  window: OrchestrationUsageLimitHistoryWindow,
  point: OrchestrationUsageLimitHistoryWindow["points"][number],
  history: ReadonlyArray<OrchestrationUsageLimitHistoryWindow>,
): UsageLimitsSnapshot {
  return {
    limitId: null,
    limitName: null,
    planType: null,
    rateLimitReachedType: null,
    credits: null,
    primary: {
      ...(window.windowKey ? { key: window.windowKey } : {}),
      usedPercent: point.usedPercent,
      resetsAt: window.resetsAt,
      windowDurationMins: window.windowDurationMins,
    },
    secondary: null,
    history,
    updatedAt: point.observedAt,
  };
}

function deriveForecast(
  snapshot: UsageLimitsSnapshot,
  observedAtMs: number,
  historyMaxProjectionWeight?: number,
): number | null {
  const options = historyMaxProjectionWeight === undefined ? {} : { historyMaxProjectionWeight };
  return (
    deriveDisplayedUsageLimitsSnapshot(snapshot, observedAtMs, options)?.primary
      ?.projectedPercentAtReset ?? null
  );
}

function evaluateGroup(
  windows: ReadonlyArray<OrchestrationUsageLimitHistoryWindow>,
  evaluationAtMs: number,
): EvaluationAccumulator {
  const accumulator = makeAccumulator();
  const sorted = windows.toSorted(
    (left, right) => Date.parse(left.resetsAt) - Date.parse(right.resetsAt),
  );
  accumulator.windowCount = sorted.length;

  for (const [windowIndex, window] of sorted.entries()) {
    const resetMs = Date.parse(window.resetsAt);
    const durationMs = window.windowDurationMins * 60 * 1000;
    if (!Number.isFinite(resetMs) || !Number.isFinite(durationMs) || durationMs <= 0) {
      accumulator.unobservedCompletionWindowCount += 1;
      continue;
    }

    const points = window.points
      .filter((point) => Number.isFinite(Date.parse(point.observedAt)))
      .toSorted((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
    const finalPoint = points.at(-1);
    if (!finalPoint) {
      accumulator.unobservedCompletionWindowCount += 1;
      continue;
    }

    const finalObservedAtMs = Date.parse(finalPoint.observedAt);
    const reachedLimit = finalPoint.usedPercent >= 100;
    const observedThroughReset = finalObservedAtMs >= resetMs - RESET_COMPLETION_TOLERANCE_MS;
    if (!reachedLimit && !observedThroughReset) {
      const nextWindow = sorted[windowIndex + 1];
      const nextStartMs = nextWindow
        ? Date.parse(nextWindow.resetsAt) - nextWindow.windowDurationMins * 60 * 1000
        : null;
      if (
        nextStartMs !== null &&
        Number.isFinite(nextStartMs) &&
        nextStartMs < resetMs - RESET_COMPLETION_TOLERANCE_MS
      ) {
        accumulator.earlyResetWindowCount += 1;
      } else if (resetMs > evaluationAtMs) {
        accumulator.activeWindowCount += 1;
      } else {
        accumulator.unobservedCompletionWindowCount += 1;
      }
      continue;
    }

    accumulator.evaluatedWindowCount += 1;
    const windowStartMs = resetMs - durationMs;
    const priorWindows = sorted.filter(
      (candidate) =>
        Date.parse(candidate.resetsAt) <= windowStartMs + RESET_COMPLETION_TOLERANCE_MS,
    );
    let previousRegularized: number | null = null;
    let previousCurrent: number | null = null;

    for (const point of points.slice(0, -1)) {
      const observedAtMs = Date.parse(point.observedAt);
      const snapshot = makeReplaySnapshot(window, point, priorWindows);
      const regularized = deriveForecast(snapshot, observedAtMs, 0);
      const current = deriveForecast(snapshot, observedAtMs);

      if (regularized !== null) {
        accumulator.regularized.push({
          actual: finalPoint.usedPercent,
          forecast: regularized,
          jumpFromPrevious:
            previousRegularized === null ? null : Math.abs(regularized - previousRegularized),
        });
        previousRegularized = regularized;
      }
      if (current !== null) {
        accumulator.current.push({
          actual: finalPoint.usedPercent,
          forecast: current,
          jumpFromPrevious: previousCurrent === null ? null : Math.abs(current - previousCurrent),
        });
        previousCurrent = current;
      }
    }
  }

  return accumulator;
}

/**
 * Replays retained windows without future leakage. Only windows observed through
 * reset or through quota exhaustion contribute forecast-error measurements.
 */
export function evaluateUsageLimitForecastHistory(
  history: ReadonlyArray<OrchestrationUsageLimitHistoryWindow>,
  evaluationAtMs: number = Date.now(),
): UsageLimitForecastEvaluationReport {
  const grouped = new Map<string, Array<OrchestrationUsageLimitHistoryWindow>>();
  for (const window of history) {
    const groupKey = JSON.stringify([window.windowKey ?? null, window.windowDurationMins]);
    const windows = grouped.get(groupKey) ?? [];
    windows.push(window);
    grouped.set(groupKey, windows);
  }

  const overall = makeAccumulator();
  const groups = Array.from(grouped.values())
    .map((windows) => {
      const accumulator = evaluateGroup(windows, evaluationAtMs);
      addAccumulator(overall, accumulator);
      const first = windows[0]!;
      return {
        windowKey: first.windowKey ?? null,
        windowDurationMins: first.windowDurationMins,
        ...finishAccumulator(accumulator),
      };
    })
    .toSorted(
      (left, right) =>
        left.windowDurationMins - right.windowDurationMins ||
        (left.windowKey ?? "").localeCompare(right.windowKey ?? ""),
    );

  return { overall: finishAccumulator(overall), groups };
}
