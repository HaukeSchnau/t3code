import type { OrchestrationThreadActivity, ProviderKind } from "@t3tools/contracts";

import { formatRelativeTimeUntilLabel } from "../timestampFormat";

const WEEKLY_WINDOW_DURATION_MINS = 7 * 24 * 60;
const WEEKDAY_USAGE_WEIGHT = 1;
const WEEKEND_USAGE_WEIGHT = 0.25;

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
  updatedAt: string;
}

export interface UsageLimitsActivitySource {
  provider: ProviderKind | null;
  activities: ReadonlyArray<OrchestrationThreadActivity> | null | undefined;
}

export type UsageLimitWindowStatus = "ok" | "atRisk" | "reached" | "unknown";

export interface DerivedUsageLimitWindowSnapshot extends UsageLimitWindowSnapshot {
  durationLabel: string | null;
  resetRelativeLabel: string | null;
  resetAbsoluteLabel: string | null;
  elapsedPercent: number | null;
  projectedPercentAtReset: number | null;
  status: UsageLimitWindowStatus;
}

export interface DerivedUsageLimitsSnapshot extends Omit<
  UsageLimitsSnapshot,
  "primary" | "secondary"
> {
  primary: DerivedUsageLimitWindowSnapshot | null;
  secondary: DerivedUsageLimitWindowSnapshot | null;
  compactWindow: "primary" | "secondary" | null;
  compactWindowStatus: UsageLimitWindowStatus | null;
}

function normalizeWindow(value: unknown): UsageLimitWindowSnapshot | null {
  const record = asRecord(value);
  const usedPercent = asFiniteNumber(record?.usedPercent);
  if (usedPercent === null) {
    return null;
  }

  return {
    usedPercent,
    resetsAt: normalizeResetAt(record?.resetsAt),
    windowDurationMins: asFiniteNumber(record?.windowDurationMins),
  };
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

function startOfNextLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0).getTime();
}

function deriveWeightedDurationMs(startMs: number, endMs: number): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return 0;
  }

  let cursorMs = startMs;
  let weightedMs = 0;

  while (cursorMs < endMs) {
    const cursorDate = new Date(cursorMs);
    const nextBoundaryMs = Math.min(startOfNextLocalDay(cursorDate), endMs);
    const weight = isWeekendLocal(cursorDate) ? WEEKEND_USAGE_WEIGHT : WEEKDAY_USAGE_WEIGHT;
    weightedMs += (nextBoundaryMs - cursorMs) * weight;
    cursorMs = nextBoundaryMs;
  }

  return weightedMs;
}

function deriveWallClockElapsedPercent(
  resetMs: number,
  durationMs: number,
  nowMs: number,
): number | null {
  const elapsedMs = durationMs - Math.max(0, resetMs - nowMs);
  const elapsedPercent = (elapsedMs / durationMs) * 100;
  return Math.max(0, Math.min(100, elapsedPercent));
}

function deriveWeeklyWeightedElapsedPercent(
  resetMs: number,
  durationMs: number,
  nowMs: number,
): number | null {
  const windowStartMs = resetMs - durationMs;
  const effectiveNowMs = Math.min(Math.max(nowMs, windowStartMs), resetMs);
  const weightedTotalMs = deriveWeightedDurationMs(windowStartMs, resetMs);
  if (weightedTotalMs <= 0) {
    return null;
  }

  const weightedElapsedMs = deriveWeightedDurationMs(windowStartMs, effectiveNowMs);
  return Math.max(0, Math.min(100, (weightedElapsedMs / weightedTotalMs) * 100));
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
  if (window.windowDurationMins === WEEKLY_WINDOW_DURATION_MINS) {
    return deriveWeeklyWeightedElapsedPercent(resetMs, durationMs, nowMs);
  }

  return deriveWallClockElapsedPercent(resetMs, durationMs, nowMs);
}

function deriveProjectedPercentAtReset(
  usedPercent: number,
  elapsedPercent: number | null,
): number | null {
  if (elapsedPercent === null || elapsedPercent <= 0) {
    return null;
  }
  return (usedPercent / elapsedPercent) * 100;
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

function deriveWindowDisplay(
  window: UsageLimitWindowSnapshot | null,
  rateLimitReachedType: string | null,
  nowMs: number,
): DerivedUsageLimitWindowSnapshot | null {
  if (!window) {
    return null;
  }

  const elapsedPercent = deriveProjectionElapsedPercent(window, nowMs);
  const projectedPercentAtReset = deriveProjectedPercentAtReset(window.usedPercent, elapsedPercent);

  return {
    ...window,
    durationLabel: formatWindowDurationLabel(window.windowDurationMins),
    resetRelativeLabel: window.resetsAt ? formatRelativeTimeUntilLabel(window.resetsAt) : null,
    resetAbsoluteLabel: formatAbsoluteResetLabel(window.resetsAt),
    elapsedPercent,
    projectedPercentAtReset,
    status: deriveWindowStatus({
      usedPercent: window.usedPercent,
      projectedPercentAtReset,
      rateLimitReachedType,
    }),
  };
}

export function deriveLatestUsageLimitsSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): UsageLimitsSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "account.rate-limits.updated") {
      continue;
    }

    const payload = asRecord(activity.payload);
    const primary = normalizeWindow(payload?.primary);
    const secondary = normalizeWindow(payload?.secondary);
    if (primary === null && secondary === null) {
      continue;
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
      updatedAt: activity.createdAt,
    };
  }

  return null;
}

export function deriveLatestUsageLimitsSnapshotForSources(
  sources: ReadonlyArray<UsageLimitsActivitySource>,
  provider: ProviderKind | null | undefined = null,
): UsageLimitsSnapshot | null {
  let latestSnapshot: UsageLimitsSnapshot | null = null;
  let latestUpdatedAtMs = Number.NEGATIVE_INFINITY;

  for (const source of sources) {
    if (provider && source.provider !== provider) {
      continue;
    }

    const snapshot = deriveLatestUsageLimitsSnapshot(source.activities ?? []);
    if (!snapshot) {
      continue;
    }

    const updatedAtMs = Date.parse(snapshot.updatedAt);
    if (!Number.isFinite(updatedAtMs)) {
      continue;
    }

    if (latestSnapshot === null || updatedAtMs >= latestUpdatedAtMs) {
      latestSnapshot = snapshot;
      latestUpdatedAtMs = updatedAtMs;
    }
  }

  return latestSnapshot;
}

export function deriveDisplayedUsageLimitsSnapshot(
  snapshot: UsageLimitsSnapshot | null,
  nowMs: number = Date.now(),
): DerivedUsageLimitsSnapshot | null {
  if (!snapshot) {
    return null;
  }

  const primary = deriveWindowDisplay(snapshot.primary, snapshot.rateLimitReachedType, nowMs);
  const secondary = deriveWindowDisplay(snapshot.secondary, snapshot.rateLimitReachedType, nowMs);
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
    compactWindow,
    compactWindowStatus,
  };
}
