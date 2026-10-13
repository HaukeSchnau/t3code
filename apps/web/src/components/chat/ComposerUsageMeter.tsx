import type { EnvironmentId, ServerProvider, UsageLimitSourceSnapshots } from "@t3tools/contracts";
import { formatDuration, type LimitPool } from "@t3tools/shared/usageLimits";
import { Fragment } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { barColor, LimitWindows, PaceIcon } from "../usage/UsageLimits";
import { composerFloatingLayerProps } from "./composerEventScope";
import { type MeterTone, meterRows, meterSource } from "./ComposerUsageMeter.logic";

const TONE_COLOR: Record<Exclude<MeterTone, "normal">, string> = {
  ahead: "var(--color-warning)",
  low: "var(--color-error)",
};

/** Quota left in the active provider's session and weekly windows, with every window on hover. */
export function ComposerUsageMeter({
  environmentId,
  provider,
  sources,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly sources: UsageLimitSourceSnapshots;
}) {
  // The clock is a UTC ISO minute, which is all the pace and reset labels need.
  const now = Date.parse(`${useNowMinute()}:00Z`);
  const source = meterSource(environmentId, provider, sources, now);
  if (!source) return null;
  const shown = meterRows(source, now).map((row) => ({
    ...row,
    color: row.tone === "normal" ? barColor(provider.driver) : TONE_COLOR[row.tone],
  }));

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
              .map(({ label, remaining }) => `${label} ${remaining}% left`)
              .join(", ")}`}
          >
            <span className="flex flex-col gap-1">
              {shown.map(({ id, shortLabel, remaining, color, tone }) => (
                <span
                  key={id}
                  className="flex items-center gap-1.5 text-3xs leading-none tabular-nums"
                >
                  <span className="w-4 truncate text-muted-foreground">{shortLabel}</span>
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
          <div className="font-medium text-muted-foreground text-xs">
            {source.kind === "pool"
              ? `Usage limits · ${source.pool.accounts.length} pooled ${source.pool.accounts.length === 1 ? "account" : "accounts"}`
              : "Usage limits"}
          </div>
          {source.kind === "pool" ? (
            <PoolWindows pool={source.pool} now={now} />
          ) : (
            <LimitWindows compact driver={provider.driver} windows={source.windows} now={now} />
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** Each pooled window's share left and the next reset that hands quota back. */
function PoolWindows({ pool, now }: { readonly pool: LimitPool; readonly now: number }) {
  return (
    <div className="grid grid-cols-[minmax(0,9rem)_auto] gap-x-3 gap-y-0.5 text-xs">
      {pool.windows.map((window) => {
        const refill = window.resets.find((reset) => reset.restoresPercent > 0);
        return (
          <Fragment key={`${window.kind}:${window.id}`}>
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-muted-foreground">{window.label}</span>
              <span className="ms-auto shrink-0 font-medium text-foreground tabular-nums">
                {window.remainingPercent}% left
              </span>
            </span>
            <span className="flex items-center gap-2 whitespace-nowrap text-muted-foreground tabular-nums">
              {window.pace ? <PaceIcon pace={window.pace} /> : null}
              <span className="ms-auto shrink-0">
                {refill ? `+${refill.restoresPercent}% in ${formatDuration(refill.at - now)}` : ""}
              </span>
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}
