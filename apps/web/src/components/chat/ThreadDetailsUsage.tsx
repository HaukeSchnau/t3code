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
  type LimitAccount,
  type LimitPace,
  type LimitPoolWindow,
  type LimitProjection,
  limitsNotice,
  measuredOverWindow,
  paceOf,
  projectionPaces,
  projectLimitWindows,
  projectsLimitWindow,
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
import { AccountChip } from "../usage/UsageLimitsPooled";
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
                <LimitRow key={window.id} driver={active.driver} window={window} now={now} />
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
  driver,
  window,
  now,
}: {
  readonly driver: ProviderDriverKind;
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const left = remainingPercent(window);
  const pace = paceOf(window, now);
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  const projection = projectsLimitWindow(driver, window.id)
    ? projectLimitWindows([window], now)
    : null;
  return (
    <UsageRow
      label={window.label}
      fill={left}
      tone={left <= 10 ? "error" : left <= 20 ? "warning" : null}
      projection={projection}
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
          {projection ? (
            <ProjectionLines windows={[window]} projection={projection} now={now} />
          ) : pace ? (
            <span className="text-muted-foreground">{PACE_LABEL[pace]}</span>
          ) : null}
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
  const windows = window.members.map((member) => member.window);
  const projection = projectsLimitWindow(driver, window.id)
    ? projectLimitWindows(windows, now)
    : null;
  const pooled = window.members.length > 1;
  const measuring =
    !projection && pooled && projectsLimitWindow(driver, window.id) ? measuringNote(windows) : null;
  return (
    <UsageRow
      label={label}
      fill={left}
      tone={left <= 10 ? "error" : left <= 20 ? "warning" : null}
      projection={projection}
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
          {projection ? (
            <ProjectionLines
              windows={windows}
              projection={projection}
              now={now}
              {...(pooled ? { accounts: window.members.map((member) => member.account) } : {})}
            />
          ) : measuring ? (
            <span className="text-muted-foreground">{measuring}</span>
          ) : window.pace ? (
            <span className="text-muted-foreground">{PACE_LABEL[window.pace]}</span>
          ) : null}
          {pooled ? (
            <span className="mt-1 grid grid-cols-[auto_auto_1fr] items-center gap-x-2 gap-y-0.5 border-t border-border/60 pt-1.5 tabular-nums">
              {window.members.map((member) => {
                const resetsAt = member.window.resetsAt ? Date.parse(member.window.resetsAt) : null;
                return (
                  <Fragment key={member.account.key}>
                    <AccountMark account={member.account} />
                    <span className="text-end text-foreground">
                      {remainingPercent(member.window)}%
                    </span>
                    <span className="text-muted-foreground">
                      {resetsAt !== null && resetsAt > now
                        ? `refills in ${formatDuration(resetsAt - now)}`
                        : ""}
                    </span>
                  </Fragment>
                );
              })}
            </span>
          ) : null}
        </>
      }
    />
  );
}

/** How much of its pace a pool has measured, while that is short of forecasting and a day or longer. */
function measuringNote(windows: readonly ServerProviderUsageWindow[]): string | null {
  if (windows.every(measuredOverWindow)) return null;
  const windowDays = Math.max(...windows.map((window) => window.windowDurationMins ?? 0)) / 1440;
  if (windowDays < 1) return null;
  const days = Math.min(...windows.map((window) => window.recentSpend?.hours ?? 0)) / 24;
  return `Measuring the pool's pace before forecasting: ${Math.floor(days)} of ${Math.round(windowDays)} days read`;
}

function AccountMark({ account }: { readonly account: LimitAccount }) {
  if (account.email) return <AccountChip email={account.email} />;
  return (
    <span className="text-foreground">
      {account.displayName ?? providerClients.get(account.driver)?.label ?? String(account.driver)}
    </span>
  );
}

/** What the projection means, in words. Mounts only while the tooltip is open. */
function ProjectionLines({
  windows,
  projection,
  now,
  accounts,
}: {
  readonly windows: readonly ServerProviderUsageWindow[];
  readonly projection: LimitProjection;
  readonly now: number;
  /** A pool's accounts, in window order; a single window has none. */
  readonly accounts?: readonly LimitAccount[];
}) {
  const paces = projectionPaces(windows, now);
  const [dry] = projection.dry;
  const dryTotal = projection.dry.reduce((sum, stretch) => sum + stretch.until - stretch.from, 0);
  const expiring = projection.expiring.toSorted((a, b) => b.percent - a.percent).slice(0, 2);
  const safe = Math.floor(paces.safe * 10) / 10;
  const measuredHours = windows.every(measuredOverWindow)
    ? Math.min(...windows.map((window) => window.recentSpend!.hours))
    : null;
  const measuredDays = measuredHours === null ? null : Math.round(measuredHours / 24);
  return (
    <>
      {dry ? (
        <span className="text-warning-foreground">
          Runs out in {formatDuration(dry.from - now)}, {formatDuration(dry.until - dry.from)}{" "}
          before{" "}
          {accounts ? (
            <>
              <AccountMark account={accounts[dry.refill]!} /> refills
            </>
          ) : (
            "it resets"
          )}
          {projection.dry.length > 1 ? `. ${formatDuration(dryTotal)} with no room in all` : ""}
        </span>
      ) : null}
      {expiring.map((entry) => (
        <span key={entry.member} className="text-foreground">
          {Math.round(entry.percent)}%{" "}
          {accounts ? (
            <>
              of <AccountMark account={accounts[entry.member]!} />{" "}
            </>
          ) : null}
          resets unused in {formatDuration(entry.at - now)}
        </span>
      ))}
      {!dry && expiring.length === 0 ? (
        <span className="text-foreground">
          Lasts until {accounts ? "the refills" : "the reset"}, with nothing left over
        </span>
      ) : null}
      <span className="text-muted-foreground">
        {dry
          ? safe > 0
            ? `Slowing to ${safe}× this pace keeps you covered`
            : "Even a crawl runs dry first"
          : paces.safe >= 3
            ? "Covered even at 3× this pace"
            : `Covered up to ${safe}× this pace`}
      </span>
      {measuredHours !== null && measuredDays !== null ? (
        <span className="text-muted-foreground">
          This pace is what {accounts && accounts.length > 1 ? "the accounts" : "the account"} spent
          over the last{" "}
          {measuredHours < 24
            ? formatDuration(measuredHours * 3_600_000)
            : measuredDays === 1
              ? "day"
              : `${measuredDays} days`}
        </span>
      ) : null}
      {paces.usesAll !== null ? (
        <span className="text-muted-foreground">
          At {Math.ceil(paces.usesAll * 10) / 10}× this pace, nothing resets unused
        </span>
      ) : null}
    </>
  );
}

// A slot cut around the pace notch, as on the Usage page, so the notch reads apart from a fill end.
function notchAt(percent: number) {
  const at = `clamp(2px, ${percent}%, calc(100% - 2px))`;
  const [left, right] = [`calc(${at} - 2px)`, `calc(${at} + 2px)`];
  const [near, far] = ["-1px", "calc(100% + 1px)"];
  return {
    left: at,
    clipPath: `polygon(${near} ${near}, ${left} ${near}, ${left} ${far}, ${right} ${far}, ${right} ${near}, ${far} ${near}, ${far} ${far}, ${near} ${far})`,
  };
}

/** One label, hairline, and value row; the whole row opens the details tooltip. */
function UsageRow({
  label,
  fill,
  tone,
  tick = null,
  projection = null,
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
  /** Splits the fill into room the pace uses and room that resets unused, and marks a shortfall. */
  readonly projection?: LimitProjection | null;
  readonly value: string;
  readonly ariaValue?: string;
  readonly tooltip: ReactNode;
  readonly muted?: boolean;
}) {
  const solid = projection ? projection.usePercent : (fill ?? 0);
  const need = projection ? Math.min(100, solid + projection.shortPercent) : null;
  const notch = need === null ? null : notchAt(need);
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
          <span className="relative h-[3px]">
            <span className="absolute inset-0" style={notch ? { clipPath: notch.clipPath } : {}}>
              <span className="absolute inset-0 rounded-full bg-muted-foreground/30 dark:bg-muted-foreground/20" />
              {projection && projection.expiresPercent > 0 ? (
                <span
                  className="absolute inset-y-0 text-foreground/50"
                  style={{
                    left: `${solid}%`,
                    width: `${projection.expiresPercent}%`,
                    backgroundImage:
                      "repeating-linear-gradient(90deg, currentColor 0 3px, transparent 3px 5px)",
                  }}
                />
              ) : null}
              {solid > 0 ? (
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
                  style={{ width: `max(${solid}%, 6px)` }}
                />
              ) : null}
              {need !== null && need > solid ? (
                <span
                  className="absolute inset-y-0 rounded-full bg-warning/55"
                  style={{ left: `${solid}%`, width: `${need - solid}%` }}
                />
              ) : null}
            </span>
            {tick !== null ? (
              <span
                aria-hidden
                className="absolute -top-[3px] h-[9px] w-px -translate-x-1/2 bg-foreground/60"
                style={{ left: `${tick}%` }}
              />
            ) : null}
            {notch ? (
              <span
                aria-hidden
                className="absolute -top-[3px] h-[9px] w-px -translate-x-1/2 bg-foreground"
                style={{ left: notch.left }}
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
