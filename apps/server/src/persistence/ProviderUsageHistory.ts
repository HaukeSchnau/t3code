import type {
  OrchestrationUsageLimitHistoryWindow,
  OrchestrationUsageLimitsSnapshot,
} from "@t3tools/contracts";

const MAX_HISTORY_WINDOWS_PER_DURATION = 8;
const MAX_POINTS_PER_WINDOW = 24;
const RESET_MATCH_TOLERANCE_MS = 5 * 60 * 1000;

export interface UsageLimitObservationInput {
  readonly observedAt: string;
  readonly resetsAt: string;
  readonly usedPercent: number;
  readonly windowDurationMins: number;
}

function compactPoints(
  points: OrchestrationUsageLimitHistoryWindow["points"],
): OrchestrationUsageLimitHistoryWindow["points"] {
  if (points.length <= MAX_POINTS_PER_WINDOW) {
    return points;
  }

  return Array.from({ length: MAX_POINTS_PER_WINDOW }, (_, index) => {
    const sourceIndex = Math.round((index * (points.length - 1)) / (MAX_POINTS_PER_WINDOW - 1));
    return points[sourceIndex]!;
  });
}

function pruneHistory(
  history: ReadonlyArray<OrchestrationUsageLimitHistoryWindow>,
): ReadonlyArray<OrchestrationUsageLimitHistoryWindow> {
  const windowsByDuration = new Map<number, Array<OrchestrationUsageLimitHistoryWindow>>();
  for (const window of history) {
    const windows = windowsByDuration.get(window.windowDurationMins) ?? [];
    windows.push(window);
    windowsByDuration.set(window.windowDurationMins, windows);
  }

  return Array.from(windowsByDuration.values())
    .flatMap((windows) =>
      windows
        .toSorted((left, right) => Date.parse(left.resetsAt) - Date.parse(right.resetsAt))
        .slice(-MAX_HISTORY_WINDOWS_PER_DURATION),
    )
    .toSorted((left, right) => Date.parse(left.resetsAt) - Date.parse(right.resetsAt));
}

export function appendUsageLimitObservation(
  history: ReadonlyArray<OrchestrationUsageLimitHistoryWindow>,
  observation: UsageLimitObservationInput,
): ReadonlyArray<OrchestrationUsageLimitHistoryWindow> {
  if (
    observation.usedPercent <= 0 ||
    observation.windowDurationMins <= 0 ||
    !Number.isFinite(Date.parse(observation.resetsAt)) ||
    !Number.isFinite(Date.parse(observation.observedAt))
  ) {
    return history;
  }

  const resetMs = Date.parse(observation.resetsAt);
  const existing = history.findLast(
    (window) =>
      window.windowDurationMins === observation.windowDurationMins &&
      Math.abs(Date.parse(window.resetsAt) - resetMs) <= RESET_MATCH_TOLERANCE_MS,
  );
  const lastPoint = existing?.points.at(-1);
  if (lastPoint && observation.usedPercent <= lastPoint.usedPercent) {
    return history;
  }

  const point = {
    observedAt: observation.observedAt,
    usedPercent: observation.usedPercent,
  };
  if (!existing) {
    return pruneHistory([
      ...history,
      {
        resetsAt: observation.resetsAt,
        windowDurationMins: observation.windowDurationMins,
        points: [point],
      },
    ]);
  }

  return pruneHistory(
    history.map((window) =>
      window === existing
        ? { ...window, points: compactPoints([...window.points, point]) }
        : window,
    ),
  );
}

export function appendProviderUsageHistory(
  history: ReadonlyArray<OrchestrationUsageLimitHistoryWindow>,
  usageLimits: OrchestrationUsageLimitsSnapshot,
): ReadonlyArray<OrchestrationUsageLimitHistoryWindow> {
  let next = history;
  for (const window of [usageLimits.primary, usageLimits.secondary]) {
    if (!window?.resetsAt || !window.windowDurationMins) {
      continue;
    }
    next = appendUsageLimitObservation(next, {
      observedAt: usageLimits.updatedAt,
      resetsAt: window.resetsAt,
      usedPercent: window.usedPercent,
      windowDurationMins: window.windowDurationMins,
    });
  }
  return next;
}
