import { useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import {
  deriveDisplayedUsageLimitsSnapshot,
  type UsageLimitsSnapshot,
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

export function UsageLimitsMeter(props: { usageLimits: UsageLimitsSnapshot }) {
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

  const normalizedPercentage = Math.max(0, Math.min(100, compactWindow.usedPercent));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (normalizedPercentage / 100) * circumference;
  const creditsLine = formatCreditsLine(usage.credits);
  const planLabel = formatPlanType(usage.planType);
  const compactToneClass = windowStatusTone(compactWindow.status);

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className="group inline-flex items-center justify-center rounded-full transition-opacity hover:opacity-85"
            aria-label={
              compactWindow.resetRelativeLabel
                ? `${usage.limitName ?? "Codex usage"} ${formatPercent(compactWindow.usedPercent)} used, resets ${compactWindow.resetRelativeLabel}`
                : `${usage.limitName ?? "Codex usage"} ${formatPercent(compactWindow.usedPercent)} used`
            }
          >
            <span className="relative flex h-6 w-6 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 h-full w-full transform-gpu"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted) 70%, transparent)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className={cn(
                    "transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none",
                    compactToneClass,
                  )}
                />
              </svg>
              <span
                className={cn(
                  "relative flex h-[15px] w-[15px] items-center justify-center rounded-full bg-background text-[8px] font-medium",
                  compactToneClass,
                )}
              >
                {Math.round(compactWindow.usedPercent)}
              </span>
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
