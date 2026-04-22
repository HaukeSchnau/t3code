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

function buildWindowLabel(name: "Primary" | "Secondary", durationLabel: string | null): string {
  return durationLabel ? `${name} ${durationLabel} window` : `${name} window`;
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

function buildInlineWindowStats(windowSnapshot: DerivedUsageLimitWindowSnapshot): {
  readonly resetLabel: string | null;
  readonly paceLabel: string | null;
} {
  const resetLabel = formatResetCountdownLabel(windowSnapshot.resetRelativeLabel);
  const projectedUsage = formatProjectedUsage(windowSnapshot.projectedPercentAtReset);

  if (windowSnapshot.status === "reached") {
    return {
      resetLabel,
      paceLabel: "hit",
    };
  }

  if (windowSnapshot.status === "unknown") {
    return {
      resetLabel,
      paceLabel: projectedUsage ? `${projectedUsage} pace` : null,
    };
  }

  return {
    resetLabel,
    paceLabel: projectedUsage ? `${projectedUsage} pace` : null,
  };
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
  const visibleWindows = [
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
  const inlineAriaLabel =
    visibleWindows.length > 0
      ? `${usage.limitName ?? "Codex usage"}. ${visibleWindows
          .map(({ label, snapshot }) => {
            return [label, formatPercent(snapshot.usedPercent), windowStatusLabel(snapshot.status)]
              .filter((part) => part && part.length > 0)
              .join(" ");
          })
          .join(". ")}`
      : `${usage.limitName ?? "Codex usage"} ${formatPercent(compactWindow.usedPercent)} used`;

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
              {visibleWindows.map(({ key, label, snapshot }) => {
                const stats = buildInlineWindowStats(snapshot);
                const normalizedPercentage = Math.max(0, Math.min(100, snapshot.usedPercent));
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
                      {formatPercent(snapshot.usedPercent)}
                    </span>
                    <span className="min-w-0 truncate text-muted-foreground">
                      {stats.resetLabel ?? windowStatusLabel(snapshot.status)}
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
              {usage.limitName ?? "Codex usage"}
            </div>
            {planLabel ? <div className="text-xs text-foreground">{planLabel}</div> : null}
            {creditsLine ? (
              <div className="text-xs text-muted-foreground">{creditsLine}</div>
            ) : null}
          </div>

          {[usage.primary, usage.secondary].map((windowSnapshot, index) => {
            if (!windowSnapshot) {
              return null;
            }

            const label = buildWindowLabel(
              index === 0 ? "Primary" : "Secondary",
              windowSnapshot.durationLabel,
            );
            const projectedUsage = formatProjectedUsage(windowSnapshot.projectedPercentAtReset);
            const assessment =
              windowSnapshot.status === "reached"
                ? "Limit reached."
                : windowSnapshot.status === "atRisk"
                  ? `At current pace, projects to ${projectedUsage ?? "100%+"} by reset.`
                  : windowSnapshot.status === "ok"
                    ? `On pace to land near ${projectedUsage ?? "0%"} by reset.`
                    : "Pace estimate unavailable.";

            return (
              <div key={label} className="space-y-1 rounded-md border border-border/60 px-2.5 py-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-medium text-foreground">{label}</div>
                  <div
                    className={cn("text-xs font-medium", windowStatusTone(windowSnapshot.status))}
                  >
                    {formatPercent(windowSnapshot.usedPercent)} used
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">
                  {windowSnapshot.resetRelativeLabel && windowSnapshot.resetAbsoluteLabel
                    ? `Resets ${windowSnapshot.resetRelativeLabel} at ${windowSnapshot.resetAbsoluteLabel}`
                    : windowSnapshot.resetRelativeLabel
                      ? `Resets ${windowSnapshot.resetRelativeLabel}`
                      : windowSnapshot.resetAbsoluteLabel
                        ? `Resets at ${windowSnapshot.resetAbsoluteLabel}`
                        : "Reset time unavailable"}
                </div>
                <div className="text-xs text-muted-foreground">{assessment}</div>
              </div>
            );
          })}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
