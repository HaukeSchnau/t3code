import type { ServerProvider } from "@t3tools/contracts";
import { limitsNotice, remainingPercent } from "@t3tools/shared/usageLimits";

import { useNowMinute } from "../../hooks/useNowMinute";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { barColor, LimitWindows } from "../usage/UsageLimits";
import { composerFloatingLayerProps } from "./composerEventScope";
import {
  type MeterTone,
  meterTone,
  meterWindows,
  windowShortLabel,
} from "./ComposerUsageMeter.logic";

const TONE_COLOR: Record<Exclude<MeterTone, "normal">, string> = {
  ahead: "var(--color-warning)",
  low: "var(--color-error)",
};

/** Quota left in the active provider's session and weekly windows, with every window on hover. */
export function ComposerUsageMeter({ provider }: { readonly provider: ServerProvider }) {
  // The clock is a UTC ISO minute, which is all the pace and reset labels need.
  const now = Date.parse(`${useNowMinute()}:00Z`);
  const limits = provider.usageLimits;
  if (!limits || limitsNotice(limits) !== null) return null;
  const shown = meterWindows(limits.windows).map((window) => {
    const tone = meterTone(window, now);
    return {
      window,
      label: windowShortLabel(window),
      remaining: remainingPercent(window),
      color: tone === "normal" ? barColor(provider.driver) : TONE_COLOR[tone],
      tone,
    };
  });

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <Button
            size="compact"
            variant="ghost-muted"
            aria-label={`Usage limits: ${shown
              .map(({ window, remaining }) => `${window.label} ${remaining}% left`)
              .join(", ")}`}
          >
            <span className="flex flex-col gap-1">
              {shown.map(({ window, label, remaining, color, tone }) => (
                <span
                  key={window.id}
                  className="flex items-center gap-1.5 text-3xs leading-none tabular-nums"
                >
                  <span className="w-4 truncate text-muted-foreground">{label}</span>
                  <span className="relative h-1 w-8 overflow-hidden rounded-full bg-muted">
                    <span
                      className="absolute inset-y-0 left-0 rounded-full"
                      style={{ width: `${remaining}%`, backgroundColor: color }}
                    />
                  </span>
                  <span
                    className="w-6 text-right font-medium text-foreground"
                    style={tone === "normal" ? undefined : { color }}
                  >
                    {remaining}%
                  </span>
                </span>
              ))}
            </span>
          </Button>
        }
      />
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side="top"
        align="end"
        padding="none"
        width="md"
        className="text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-(--floating-content-inset)">
          <div className="font-medium text-muted-foreground text-xs">Usage limits</div>
          <LimitWindows compact driver={provider.driver} windows={limits.windows} now={now} />
        </div>
      </PopoverPopup>
    </Popover>
  );
}
