import { useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import {
  deriveDisplayedUsageLimitsSnapshot,
  type DerivedUsageLimitWindowSnapshot,
  type UsageLimitsSnapshot,
  type UsageLimitWindowStatus,
} from "../../lib/usageLimits";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function formatPlanType(value: string | null): string | null {
  if (!value) {
    return null;
  }
  return value
    .split(/[_\s-]+/g)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment[0]!.toUpperCase() + segment.slice(1))
    .join(" ");
}

function formatProjectedUsage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  return `${Math.round(value)}%`;
}

function formatResetCountdownLabel(value: string | null): string | null {
  if (!value) {
    return null;
  }
  return value.replace(/\s+left$/i, "");
}

function formatWindowBadgeLabel(durationLabel: string | null, fallback: "5h" | "1w"): string {
  return durationLabel ?? fallback;
}

function formatCreditsLine(credits: UsageLimitsSnapshot["credits"]): string | null {
  if (!credits) {
    return null;
  }
  if (credits.unlimited) {
    return "Credits: unlimited";
  }
  if (credits.balance) {
    return `Credits balance: ${credits.balance}`;
  }
  if (credits.hasCredits) {
    return "Credits available";
  }
  return null;
}

function buildWindowLabel(durationLabel: string | null, fallback: "5h" | "1w"): string {
  return `${formatWindowBadgeLabel(durationLabel, fallback)} window`;
}

function windowStatusTone(status: "ok" | "atRisk" | "reached" | "unknown"): string {
  switch (status) {
    case "reached":
      return "text-red-500";
    case "atRisk":
      return "text-amber-500";
    default:
      return "text-muted-foreground";
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function projectedSeverityColor(windowSnapshot: DerivedUsageLimitWindowSnapshot): string | null {
  if (windowSnapshot.status === "unknown") {
    return null;
  }
  if (windowSnapshot.status === "reached") {
    return "hsl(4 78% 56%)";
  }

  const projected = windowSnapshot.projectedPercentAtReset;
  if (projected === null || !Number.isFinite(projected)) {
    return null;
  }

  // 40% projected usage reads comfortably safe, 100% is right on the edge,
  // and 160%+ is firmly over the line.
  const normalized = clamp((projected - 40) / 120, 0, 1);
  const hue = 135 - normalized * 135;
  const saturation = 72;
  const lightness = 48;
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

function windowStatusLabel(status: UsageLimitWindowStatus): string {
  switch (status) {
    case "reached":
      return "Hit";
    case "atRisk":
      return "Risk";
    case "ok":
      return "Safe";
    default:
      return "Unclear";
  }
}

function formatDurationParts(totalMinutes: number): string {
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  return [
    days > 0 ? `${days}d` : null,
    hours > 0 ? `${hours}h` : null,
    minutes > 0 ? `${minutes}m` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
}

function formatApproximateDurationUntil(
  targetMs: number,
  nowMs: number,
): {
  readonly compact: string;
  readonly long: string;
} {
  const deltaMs = Math.max(0, targetMs - nowMs);
  const hours = deltaMs / (60 * 60 * 1000);

  if (hours < 6) {
    const roundedMinutes = Math.max(15, Math.round(deltaMs / (15 * 60 * 1000)) * 15);
    const label = formatDurationParts(roundedMinutes);
    return { compact: label.replaceAll(" ", ""), long: label };
  }

  if (hours < 48) {
    const roundedHours = Math.max(1, Math.round(hours));
    const label = formatDurationParts(roundedHours * 60);
    return { compact: label.replaceAll(" ", ""), long: label };
  }

  const roundedDays = Math.max(1, Math.round(hours / 24));
  return {
    compact: `${roundedDays}d`,
    long: `${roundedDays} ${roundedDays === 1 ? "day" : "days"}`,
  };
}

function formatEstimatedMoment(targetMs: number, nowMs: number): string {
  const deltaMs = targetMs - nowMs;
  if (deltaMs > 48 * 60 * 60 * 1000) {
    const hour = new Date(targetMs).getHours();
    const daypart = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
    const date = new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(new Date(targetMs));
    return `${date} ${daypart}`;
  }

  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(targetMs));
}

function buildInlineWindowStats(
  windowSnapshot: DerivedUsageLimitWindowSnapshot,
  nowMs: number,
): { readonly trailingLabel: string | null } {
  const resetLabel = formatResetCountdownLabel(windowSnapshot.resetRelativeLabel);

  if (windowSnapshot.status === "reached") {
    return {
      trailingLabel: resetLabel ? `resets ${resetLabel}` : "hit",
    };
  }

  if (windowSnapshot.depletionForecast.kind === "beforeReset") {
    const duration = formatApproximateDurationUntil(
      windowSnapshot.depletionForecast.estimatedAtMs,
      nowMs,
    );
    return {
      trailingLabel: `out ~${duration.compact}`,
    };
  }

  return {
    trailingLabel: resetLabel ?? windowStatusLabel(windowSnapshot.status),
  };
}

function readInlineProjectedPercent(windowSnapshot: DerivedUsageLimitWindowSnapshot): number {
  return windowSnapshot.projectedPercentAtReset !== null &&
    Number.isFinite(windowSnapshot.projectedPercentAtReset)
    ? windowSnapshot.projectedPercentAtReset
    : windowSnapshot.usedPercent;
}

function formatResetLine(windowSnapshot: DerivedUsageLimitWindowSnapshot): string {
  const relative = formatResetCountdownLabel(windowSnapshot.resetRelativeLabel);
  const absolute = windowSnapshot.resetAbsoluteLabel;

  if (relative && absolute) {
    return `Resets in ${relative} at ${absolute}`;
  }
  if (relative) {
    return `Resets in ${relative}`;
  }
  if (absolute) {
    return `Resets at ${absolute}`;
  }
  if (windowSnapshot.usedPercent === 0) {
    return "Not used yet";
  }
  return "Reset time unavailable";
}

function formatProjectionBasis(windowSnapshot: DerivedUsageLimitWindowSnapshot): string | null {
  if (windowSnapshot.projectionBasis !== "history" || windowSnapshot.historicalWindowCount <= 0) {
    return null;
  }
  const suffix = windowSnapshot.historicalWindowCount === 1 ? "window" : "windows";
  return `Based on ${windowSnapshot.historicalWindowCount} recent ${suffix}`;
}

function formatDepletionLine(
  windowSnapshot: DerivedUsageLimitWindowSnapshot,
  nowMs: number,
): string | null {
  const forecast = windowSnapshot.depletionForecast;
  if (forecast.kind === "reached") {
    const resetLabel = formatResetCountdownLabel(windowSnapshot.resetRelativeLabel);
    return resetLabel ? `Available again in ${resetLabel}.` : null;
  }
  if (forecast.kind === "untilReset") {
    return windowSnapshot.projectionBasis === "regularized"
      ? "Early estimate: expected to last until reset."
      : "Expected to last until reset.";
  }
  if (forecast.kind !== "beforeReset") {
    return null;
  }

  const duration = formatApproximateDurationUntil(forecast.estimatedAtMs, nowMs);
  const moment = formatEstimatedMoment(forecast.estimatedAtMs, nowMs);
  return windowSnapshot.projectionBasis === "regularized"
    ? `Early estimate: may run out in about ${duration.long}, around ${moment}.`
    : `Likely out in about ${duration.long}, around ${moment}.`;
}

function formatProjectionRange(
  windowSnapshot: DerivedUsageLimitWindowSnapshot,
  nowMs: number,
): string | null {
  const depletion = windowSnapshot.depletionForecast;
  if (depletion.kind === "beforeReset" && depletion.range) {
    const earliest = formatApproximateDurationUntil(depletion.range.earliestAtMs, nowMs);
    if (depletion.range.latestAtMs === null) {
      return `Could run out as early as ${earliest.long}, but may last until reset.`;
    }
    const latest = formatApproximateDurationUntil(depletion.range.latestAtMs, nowMs);
    return `Typical timing: ${earliest.long} to ${latest.long}.`;
  }

  const range = windowSnapshot.projectedPercentRange;
  return range ? `Typical range: ${formatPercent(range.low)}–${formatPercent(range.high)}` : null;
}

export function UsageLimitsMeter(props: { usageLimits: UsageLimitsSnapshot; compact?: boolean }) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const usage = useMemo(
    () => deriveDisplayedUsageLimitsSnapshot(props.usageLimits, nowMs),
    [nowMs, props.usageLimits],
  );
  const compactWindow =
    usage?.compactWindow === "primary"
      ? usage.primary
      : usage?.compactWindow === "secondary"
        ? usage.secondary
        : null;
  if (!usage || !compactWindow) {
    return null;
  }

  const creditsLine = formatCreditsLine(usage.credits);
  const planLabel = formatPlanType(usage.planType);
  const primaryLabel = usage.primary
    ? formatWindowBadgeLabel(usage.primary.durationLabel, "5h")
    : null;
  const secondaryLabel = usage.secondary
    ? formatWindowBadgeLabel(usage.secondary.durationLabel, "1w")
    : null;
  const compactWindows = [
    usage.primary
      ? {
          key: "primary",
          label: primaryLabel ?? "5h",
          snapshot: usage.primary,
        }
      : null,
    usage.secondary
      ? {
          key: "secondary",
          label: secondaryLabel ?? "1w",
          snapshot: usage.secondary,
        }
      : null,
  ].filter(
    (entry): entry is { key: string; label: string; snapshot: DerivedUsageLimitWindowSnapshot } =>
      entry !== null,
  );
  const detailWindows =
    usage.windows.length > 0 ? usage.windows : compactWindows.map((entry) => entry.snapshot);
  const inlineAriaLabel =
    compactWindows.length > 0
      ? `${usage.limitName ?? "Usage limits"}. ${compactWindows
          .map(({ label, snapshot }) => {
            return [
              label,
              `${formatPercent(readInlineProjectedPercent(snapshot))} forecast`,
              `${formatPercent(snapshot.usedPercent)} used`,
              formatDepletionLine(snapshot, nowMs),
              formatProjectionBasis(snapshot),
              formatProjectionRange(snapshot, nowMs),
            ]
              .filter((part) => part && part.length > 0)
              .join(" ");
          })
          .join(". ")}`
      : `${usage.limitName ?? "Usage limits"} ${formatPercent(compactWindow.usedPercent)} used`;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className={cn(
              "group inline-flex min-h-10 max-w-full items-center rounded-md px-1.5 py-1 text-left transition-[background-color,opacity,transform] duration-150 ease-out hover:bg-muted/35 hover:opacity-95 active:scale-[0.96]",
              props.compact ? "max-w-36" : "max-w-44",
            )}
            aria-label={inlineAriaLabel}
          >
            <span className="min-w-0 flex flex-col gap-0.5 overflow-hidden text-[11px] leading-none tabular-nums">
              {compactWindows.map(({ key, label, snapshot }) => {
                const stats = buildInlineWindowStats(snapshot, nowMs);
                const projectedPercent = readInlineProjectedPercent(snapshot);
                const normalizedPercentage = Math.max(0, Math.min(100, projectedPercent));
                const severityColor = projectedSeverityColor(snapshot);
                return (
                  <span key={key} className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                    <span className="w-5 shrink-0 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                      {label}
                    </span>
                    <span
                      className="relative h-1.5 w-6 shrink-0 overflow-hidden rounded-full bg-muted/70"
                      aria-hidden="true"
                    >
                      <span
                        className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ease-out"
                        style={{
                          width: `${normalizedPercentage}%`,
                          ...(severityColor ? { backgroundColor: severityColor } : {}),
                        }}
                      />
                    </span>
                    <span
                      className={cn(
                        "w-9 shrink-0 text-[12px] font-semibold",
                        windowStatusTone(snapshot.status),
                      )}
                      style={severityColor ? { color: severityColor } : undefined}
                    >
                      {formatPercent(projectedPercent)}
                    </span>
                    <span className="min-w-0 truncate text-muted-foreground">
                      {stats.trailingLabel}
                    </span>
                  </span>
                );
              })}
            </span>
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="end" className="w-72 max-w-none px-3 py-2">
        <div className="space-y-2 leading-tight">
          <div className="space-y-1">
            <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              {usage.limitName ?? "Usage limits"}
            </div>
            {planLabel ? <div className="text-xs text-foreground">{planLabel}</div> : null}
            {creditsLine ? (
              <div className="text-xs text-muted-foreground">{creditsLine}</div>
            ) : null}
          </div>

          {detailWindows.map((windowSnapshot, index) => {
            const durationFallback = windowSnapshot.windowDurationMins === 5 * 60 ? "5h" : "1w";
            const durationLabel = formatWindowBadgeLabel(
              windowSnapshot.durationLabel,
              durationFallback,
            );
            const label = windowSnapshot.label
              ? `${windowSnapshot.label} · ${durationLabel}`
              : buildWindowLabel(windowSnapshot.durationLabel, durationFallback);
            const projectedUsage = formatProjectedUsage(windowSnapshot.projectedPercentAtReset);
            const projectionBasis = formatProjectionBasis(windowSnapshot);
            const depletionLine = formatDepletionLine(windowSnapshot, nowMs);
            const projectionRange = formatProjectionRange(windowSnapshot, nowMs);
            const assessment =
              windowSnapshot.status === "reached"
                ? "Limit reached."
                : windowSnapshot.status === "atRisk"
                  ? `Forecast: ${projectedUsage ?? "100%+"} by reset.`
                  : windowSnapshot.status === "ok"
                    ? `Forecast: ${projectedUsage ?? "0%"} by reset.`
                    : "Forecast unavailable.";

            return (
              <div
                key={windowSnapshot.key ?? `${label}-${index}`}
                className="space-y-1.5 border-t border-border/50 pt-2 first:border-t-0 first:pt-0"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-medium text-foreground">{label}</div>
                  <div
                    className={cn("text-xs font-medium", windowStatusTone(windowSnapshot.status))}
                  >
                    {formatPercent(windowSnapshot.usedPercent)} used
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatResetLine(windowSnapshot)}
                </div>
                <div className="text-xs text-muted-foreground">{assessment}</div>
                {depletionLine ? (
                  <div className="text-xs text-muted-foreground">{depletionLine}</div>
                ) : null}
                {projectionBasis ? (
                  <div className="text-xs text-muted-foreground">{projectionBasis}</div>
                ) : null}
                {projectionRange ? (
                  <div className="text-xs text-muted-foreground">{projectionRange}</div>
                ) : null}
              </div>
            );
          })}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
