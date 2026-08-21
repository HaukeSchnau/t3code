import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

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

function normalizeResetTimestamp(value: unknown): string | null {
  const text = asString(value);
  if (text) {
    return Option.match(DateTime.make(text), {
      onNone: () => null,
      onSome: DateTime.formatIso,
    });
  }

  const raw = asFiniteNumber(value);
  if (raw === null || raw <= 0) return null;
  const epochMs = raw >= 1_000_000_000_000 ? raw : raw * 1000;
  return Option.match(DateTime.make(epochMs), {
    onNone: () => null,
    onSome: DateTime.formatIso,
  });
}

interface UsageLimitWindow {
  readonly key?: string;
  readonly label?: string;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
  readonly windowDurationMins: number | null;
}

function normalizeRateLimitWindow(value: unknown): UsageLimitWindow | null {
  const record = asRecord(value);
  const usedPercent = asFiniteNumber(record?.usedPercent);
  if (usedPercent === null) return null;
  const key = asString(record?.key);
  const label = asString(record?.label);
  return {
    ...(key ? { key } : {}),
    ...(label ? { label } : {}),
    usedPercent,
    resetsAt: normalizeResetTimestamp(record?.resetsAt),
    windowDurationMins: asFiniteNumber(record?.windowDurationMins),
  };
}

function normalizeSpendControlLimitWindow(value: unknown): UsageLimitWindow | null {
  const record = asRecord(value);
  const remainingPercent = asFiniteNumber(record?.remainingPercent);
  if (remainingPercent === null) return null;
  return {
    usedPercent: Math.max(0, Math.min(100, 100 - remainingPercent)),
    resetsAt: normalizeResetTimestamp(record?.resetsAt),
    windowDurationMins: null,
  };
}

function selectSecondaryWindow(
  secondary: UsageLimitWindow | null,
  individualLimit: UsageLimitWindow | null,
): UsageLimitWindow | null {
  if (!secondary) return individualLimit;
  if (secondary.usedPercent === 0 && individualLimit && individualLimit.usedPercent > 0) {
    return individualLimit;
  }
  return secondary;
}

function hasSnapshotFields(value: Record<string, unknown>): boolean {
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

function unwrapSnapshot(value: unknown): Record<string, unknown> | null {
  let current = asRecord(value);
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current) return null;
    if (hasSnapshotFields(current)) return current;
    const nested = asRecord(current.rateLimits);
    if (!nested) return current;
    current = nested;
  }
  return current;
}

export function usageLimitsFromRuntimeEvent(event: ProviderRuntimeEvent) {
  if (event.type !== "account.rate-limits.updated") return undefined;
  const rateLimits = unwrapSnapshot(event.payload.rateLimits);
  if (!rateLimits) return undefined;

  const creditsRecord = asRecord(rateLimits.credits);
  const hasCredits = asBoolean(creditsRecord?.hasCredits);
  const unlimited = asBoolean(creditsRecord?.unlimited);
  const credits =
    hasCredits !== null && unlimited !== null
      ? { balance: asString(creditsRecord?.balance), hasCredits, unlimited }
      : null;
  const primary = normalizeRateLimitWindow(rateLimits.primary);
  const secondary = selectSecondaryWindow(
    normalizeRateLimitWindow(rateLimits.secondary),
    normalizeSpendControlLimitWindow(rateLimits.individualLimit),
  );
  const windows = Array.isArray(rateLimits.windows)
    ? rateLimits.windows.flatMap((window) => {
        const normalized = normalizeRateLimitWindow(window);
        return normalized ? [normalized] : [];
      })
    : [];
  if (
    primary === null &&
    secondary === null &&
    windows.length === 0 &&
    asString(rateLimits.limitId) === null &&
    asString(rateLimits.limitName) === null &&
    asString(rateLimits.planType) === null &&
    asString(rateLimits.rateLimitReachedType) === null &&
    credits === null
  ) {
    return undefined;
  }

  return {
    limitId: asString(rateLimits.limitId),
    limitName: asString(rateLimits.limitName),
    planType: asString(rateLimits.planType),
    rateLimitReachedType: asString(rateLimits.rateLimitReachedType),
    credits,
    primary,
    secondary,
    ...(windows.length > 0 ? { windows } : {}),
    updatedAt: event.createdAt,
  };
}
