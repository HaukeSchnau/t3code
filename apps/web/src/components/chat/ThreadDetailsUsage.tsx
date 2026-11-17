import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  collectProviderUsageLimits,
  cursorUsageWindowDetails,
  displayLimitWindows,
  formatDuration,
  type LimitPace,
  type LimitPoolWindow,
  limitsNotice,
  paceOf,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { Fragment, type ReactNode } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatContextWindowCompactionMessage } from "./compaction.logic";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { providerClients } from "../settings/providerDriverMeta";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { hubPoolFor, otherDriverPools } from "./ThreadDetailsUsage.logic";

const PACE_LABEL: Record<LimitPace, string> = {
  ahead: "Ahead of pace",
  on: "On pace",
  under: "Under pace",
};

export interface ThreadDetailsUsageInput {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly providers: readonly ServerProvider[];
  readonly sources: UsageLimitSourceSnapshots;
  readonly contextWindow: ContextWindowSnapshot | null;
}

type UsageTone = "error" | "warning" | null;

/**
 * The selected provider's limit windows, then every other provider's on the environment. Each row
 * reads as room left.
 */
export function ThreadDetailsUsage({
  environmentId,
  providerInstanceId,
  providers,
  sources,
}: Omit<ThreadDetailsUsageInput, "contextWindow">) {
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const report =
    providerInstanceId !== null
      ? collectProviderUsageLimits(providerInstanceId, providers, sources, now)
      : null;
  // Only this instance's data: the report keeps one instance per login, and any other entry may be
  // a different login or workspace, so fall back to the instance's own snapshot.
  const provider = providers.find((entry) => entry.instanceId === providerInstanceId);
  const limits =
    report?.accounts.find((entry) => entry.instanceId === providerInstanceId)?.limits ??
    provider?.usageLimits;
  const active = provider && limits ? { driver: provider.driver, limits } : null;
  const pool = active
    ? hubPoolFor(environmentId, active.driver, active.limits, sources, now)
    : null;
  const notice = active && !pool ? limitsNotice(active.limits) : null;
  const others = otherDriverPools(environmentId, active?.driver ?? null, providers, sources, now);
  if (!active && others.length === 0) return null;

  return (
    <ThreadDetailsSection
      headingId="thread-details-usage-heading"
      title="Usage limits"
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        {active ? (
          <>
            {others.length > 0 ? <DriverCaption driver={active.driver} /> : null}
            {pool ? (
              displayLimitWindows(pool).map((window) => (
                <PoolRow
                  key={`${window.kind}:${window.id}`}
                  driver={pool.driver}
                  window={window}
                  accountCount={pool.accounts.length}
                  now={now}
                />
              ))
            ) : notice ? (
              <UsageRow
                label="Limits"
                fill={null}
                tone={null}
                value="Unavailable"
                tooltip={<span className="text-foreground">{notice}</span>}
              />
            ) : (
              active.limits.windows.map((window) => (
                <LimitRow key={window.id} window={window} now={now} />
              ))
            )}
          </>
        ) : null}
        {others.map((other) => (
          <Fragment key={other.driver}>
            <DriverCaption driver={other.driver} />
            {displayLimitWindows(other).map((window) => (
              <PoolRow
                key={`${window.kind}:${window.id}`}
                driver={other.driver}
                window={window}
                accountCount={other.accounts.length}
                now={now}
              />
            ))}
          </Fragment>
        ))}
      </div>
    </ThreadDetailsSection>
  );
}

function DriverCaption({ driver }: { readonly driver: ProviderDriverKind }) {
  const label = providerClients.get(driver)?.label ?? String(driver);
  return (
    <div className="col-span-3 flex mt-1.5 h-6 items-center gap-1.5 px-2.5 text-2xs font-medium text-muted-foreground select-none first:mt-0">
      <ProviderInstanceIcon
        driverKind={driver}
        displayName={label}
        className="size-3.5"
        iconClassName="size-3"
      />
      {label}
    </div>
  );
}

/** The thread's context window. The bar fills as context is used; the tick marks auto-compaction. */
export function ThreadDetailsContext({ usage }: { readonly usage: ContextWindowSnapshot }) {
  const maxTokens = usage.maxTokens != null && usage.maxTokens > 0 ? usage.maxTokens : null;
  const used =
    maxTokens !== null && usage.usedPercentage !== null
      ? Math.round(Math.max(0, Math.min(100, usage.usedPercentage)))
      : null;
  const threshold = usage.autoCompactThreshold ?? null;
  const tick =
    maxTokens !== null && threshold !== null && threshold > 0 && threshold < maxTokens
      ? (threshold / maxTokens) * 100
      : null;
  const usedTokens = formatContextWindowTokens(usage.usedTokens);
  return (
    <ThreadDetailsSection
      headingId="thread-details-context-heading"
      title="Context window"
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        <UsageRow
          label="Context"
          fill={used}
          tone={used === null ? null : used >= 90 ? "error" : used >= 80 ? "warning" : null}
          tick={tick}
          muted
          value={
            maxTokens !== null
              ? `${usedTokens} / ${formatContextWindowTokens(maxTokens)}`
              : usedTokens
          }
          ariaValue={used !== null ? `${used}% used` : `${usedTokens} tokens used`}
          tooltip={
            <>
              <span className="text-foreground">
                {used !== null ? `Context: ${used}% used` : `Context: ${usedTokens} tokens used`}
              </span>
              {maxTokens !== null ? (
                <span className="text-muted-foreground">
                  {usage.usedTokens.toLocaleString("en-US")} of {maxTokens.toLocaleString("en-US")}{" "}
                  tokens
                </span>
              ) : null}
              {threshold !== null && threshold > 0 ? (
                <span className="text-muted-foreground">
                  {formatContextWindowCompactionMessage(threshold)}
                </span>
              ) : null}
            </>
          }
        />
      </div>
    </ThreadDetailsSection>
  );
}

function LimitRow({
  window,
  now,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const left = remainingPercent(window);
  const pace = paceOf(window, now);
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return (
    <UsageRow
      label={window.label}
      fill={left}
      tone={left <= 10 ? "error" : left <= 20 ? "warning" : null}
      value={`${left}%`}
      ariaValue={`${left}% left`}
      tooltip={
        <>
          <span className="text-foreground">
            {window.label}: {left}% left
          </span>
          {window.resetsAt && resetsAt > now ? (
            <span className="text-muted-foreground">
              Resets in {formatDuration(resetsAt - now)} ·{" "}
              {formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)}
            </span>
          ) : null}
          {pace ? <span className="text-muted-foreground">{PACE_LABEL[pace]}</span> : null}
        </>
      }
    />
  );
}

/** A window pooled across the hub's accounts, with the next reset that hands quota back. */
function PoolRow({
  driver,
  window,
  accountCount,
  now,
}: {
  readonly driver: ProviderDriverKind;
  readonly window: LimitPoolWindow;
  readonly accountCount: number;
  readonly now: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const left = window.remainingPercent;
  const refill = window.resets.find((reset) => reset.restoresPercent > 0 && reset.at > now);
  const label =
    (driver === "cursor" ? cursorUsageWindowDetails(window.id)?.label : null) ?? window.label;
  return (
    <UsageRow
      label={label}
      fill={left}
      tone={left <= 10 ? "error" : left <= 20 ? "warning" : null}
      value={`${left}%`}
      ariaValue={
        accountCount > 1 ? `${left}% left across ${accountCount} pooled accounts` : `${left}% left`
      }
      tooltip={
        <>
          <span className="text-foreground">
            {label}: {left}% left
          </span>
          {accountCount > 1 ? (
            <span className="text-muted-foreground">Pooled across {accountCount} accounts</span>
          ) : null}
          {refill ? (
            <span className="text-muted-foreground">
              +{refill.restoresPercent}% in {formatDuration(refill.at - now)} ·{" "}
              {formatUpcomingTimestamp(new Date(refill.at).toISOString(), timestampFormat, now)}
            </span>
          ) : null}
          {window.pace ? (
            <span className="text-muted-foreground">{PACE_LABEL[window.pace]}</span>
          ) : null}
        </>
      }
    />
  );
}

/** One label, hairline, and value row; the whole row opens the details tooltip. */
function UsageRow({
  label,
  fill,
  tone,
  tick = null,
  value,
  ariaValue = value,
  tooltip,
  muted = false,
}: {
  readonly label: string;
  /** Bar fill from 0 to 100. Null hides the bar. */
  readonly fill: number | null;
  readonly tone: UsageTone;
  /** A marker on the bar, from 0 to 100. */
  readonly tick?: number | null;
  readonly value: string;
  readonly ariaValue?: string;
  readonly tooltip: ReactNode;
  readonly muted?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            tabIndex={0}
            aria-label={`${label}: ${ariaValue}`}
            className="col-span-3 grid h-6 cursor-default grid-cols-subgrid items-center rounded-lg px-2.5 outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-black/[0.035] dark:hover:bg-white/[0.08] dark:data-popup-open:bg-white/[0.08]"
          />
        }
      >
        <span className="max-w-28 truncate text-muted-foreground">{label}</span>
        {fill !== null ? (
          <span className="relative h-[3px] rounded-full bg-muted-foreground/30 dark:bg-muted-foreground/20">
            {fill > 0 ? (
              <span
                className={cn(
                  "absolute inset-y-0 left-0 rounded-full",
                  tone === "error"
                    ? "bg-error"
                    : tone === "warning"
                      ? "bg-warning"
                      : muted
                        ? "bg-muted-foreground"
                        : "bg-foreground/80",
                )}
                style={{ width: `max(${fill}%, 6px)` }}
              />
            ) : null}
            {tick !== null ? (
              <span
                aria-hidden
                className="absolute -top-[3px] h-[9px] w-px -translate-x-1/2 bg-foreground/60"
                style={{ left: `${tick}%` }}
              />
            ) : null}
          </span>
        ) : null}
        <span
          className={cn(
            // Text-only rows span the bar column so they never widen the shared value column.
            "text-end font-medium tabular-nums",
            fill === null && "col-span-2",
            tone === "error"
              ? "text-error-foreground"
              : tone === "warning"
                ? "text-warning-foreground"
                : fill === null
                  ? "text-muted-foreground"
                  : "text-foreground/80",
          )}
        >
          {value}
        </span>
      </TooltipTrigger>
      {/* Rows sit 8px inside the card; clear its edge instead of overlapping it. */}
      <TooltipPopup side="left" sideOffset={16}>
        <div className="flex flex-col gap-0.5">{tooltip}</div>
      </TooltipPopup>
    </Tooltip>
  );
}
