import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  displayLimitWindows,
  type LimitAccount,
  type LimitPace,
  type LimitPoolWindow,
  type LimitProjection,
  measuredOverWindow,
  paceOf,
  paceRemainingPercent,
  projectionPaces,
  projectLimitWindows,
  projectsLimitWindow,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import {
  cursorUsageWindowDetails,
  formatDuration,
  limitsNotice,
} from "@t3tools/shared/usageLimitsCopy";
import { Link } from "@tanstack/react-router";
import { msg, T, useGT, useLocale, useMessages, Var } from "gt-react";
import { Fragment, type ReactNode } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import type { MessageResolver } from "../../i18n/messages";
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
import {
  nextPoolReset,
  otherDriverPools,
  poolSources,
  resolveThreadDetailsLimits,
} from "./ThreadDetailsUsage.logic";

const PACE_LABEL: Record<LimitPace, string> = {
  ahead: msg("Ahead of pace"),
  on: msg("On pace"),
  under: msg("Under pace"),
};

export interface ThreadDetailsUsageInput {
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly model: string | null;
  readonly providers: readonly ServerProvider[];
  readonly sources: UsageLimitSourceSnapshots;
  readonly contextWindow: ContextWindowSnapshot | null;
}

type UsageTone = "error" | "warning" | null;

function limitTone(left: number): UsageTone {
  if (left <= 10) return "error";
  if (left <= 20) return "warning";
  return null;
}

/**
 * The selected provider's limit windows, then every other provider's on the environment. Each row
 * reads as room left and opens the usage page.
 */
export function ThreadDetailsUsage({
  providerInstanceId,
  model,
  providers,
  sources,
}: Omit<ThreadDetailsUsageInput, "contextWindow">) {
  const gt = useGT();
  const m = useMessages();
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const resolved = resolveThreadDetailsLimits(providerInstanceId, model, providers, sources, now);
  const activeDriver = resolved
    ? (providers.find((provider) => provider.instanceId === providerInstanceId)?.driver ?? null)
    : null;
  const others = otherDriverPools(activeDriver, providers, sources, now);
  if (!resolved && others.length === 0) return null;

  return (
    <ThreadDetailsSection
      headingId="thread-details-usage-heading"
      title={gt("Usage limits")}
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        {resolved && activeDriver !== null ? (
          <>
            {others.length > 0 ? <DriverCaption driver={activeDriver} /> : null}
            {resolved.kind === "pool" ? (
              resolved.windows.map((window) => (
                <PoolRow
                  key={`${window.kind}:${window.id}`}
                  driver={activeDriver}
                  window={window}
                  now={now}
                />
              ))
            ) : (
              <InstanceRows driver={activeDriver} limits={resolved.limits} now={now} />
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
                label={
                  (other.driver === "cursor"
                    ? cursorUsageWindowDetails(window.id, other, m)?.label
                    : null) ?? window.label
                }
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

function InstanceRows({
  driver,
  limits,
  now,
}: {
  readonly driver: ProviderDriverKind;
  readonly limits: ServerProviderUsageLimits;
  readonly now: number;
}) {
  const gt = useGT();
  const m = useMessages();
  const notice = limitsNotice(limits, m);
  if (notice) {
    return (
      <UsageRow
        label={gt("Limits", { $context: "usage limits row label" })}
        fill={null}
        tone={null}
        value={gt("Unavailable")}
        tooltip={<span className="text-foreground">{notice}</span>}
        opensUsage
      />
    );
  }
  return limits.windows.map((window) => (
    <LimitRow key={window.id} driver={driver} window={window} now={now} />
  ));
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
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const usedTokens = formatContextWindowTokens(usage.usedTokens);
  return (
    <ThreadDetailsSection
      headingId="thread-details-context-heading"
      title={gt("Context window")}
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        <UsageRow
          label={gt("Context", { $context: "context window row label" })}
          fill={used}
          tone={used === null ? null : used >= 90 ? "error" : used >= 80 ? "warning" : null}
          tick={tick}
          muted
          value={
            maxTokens !== null
              ? `${usedTokens} / ${formatContextWindowTokens(maxTokens)}`
              : usedTokens
          }
          ariaValue={
            used !== null
              ? gt("{used}% used", { used })
              : gt("{usedTokens} tokens used", { usedTokens })
          }
          tooltip={
            <>
              <span className="text-foreground">
                {used !== null
                  ? gt("Context: {used}% used", { used })
                  : gt("Context: {usedTokens} tokens used", { usedTokens })}
              </span>
              {maxTokens !== null ? (
                <span className="text-muted-foreground">
                  {gt("{used} of {max} tokens", {
                    used: usage.usedTokens.toLocaleString(locale),
                    max: maxTokens.toLocaleString(locale),
                  })}
                </span>
              ) : null}
              {threshold !== null && threshold > 0 ? (
                <span className="text-muted-foreground">
                  {formatContextWindowCompactionMessage(threshold, m)}
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
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const left = remainingPercent(window);
  const pace = paceOf(window, now);
  const timeLeft = paceRemainingPercent(window, now);
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  const projection = projectsLimitWindow(driver, window.id)
    ? projectLimitWindows([window], now)
    : null;
  return (
    <UsageRow
      label={window.label}
      fill={left}
      tone={limitTone(left)}
      projection={projection}
      // The projection's notch replaces the pace tick.
      tick={projection ? null : timeLeft}
      value={`${left}%`}
      ariaValue={gt("{left}% left", { left })}
      opensUsage
      tooltip={
        <>
          <span className="text-foreground">
            {gt("{label}: {left}% left", { label: window.label, left })}
          </span>
          {!projection && pace && timeLeft !== null ? (
            <span className="text-muted-foreground">
              {m(PACE_LABEL[pace])} · {gt("{timeLeft}% of the window left", { timeLeft })}
            </span>
          ) : null}
          {window.resetsAt && resetsAt > now ? (
            <span className="text-muted-foreground">
              {gt("Resets in {duration} · {time}", {
                duration: formatDuration(resetsAt - now, m),
                time: formatUpcomingTimestamp(window.resetsAt, timestampFormat, now, undefined, m),
              })}
            </span>
          ) : null}
          {projection ? (
            <ProjectionLines windows={[window]} projection={projection} now={now} />
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
  label: labelOverride,
  now,
}: {
  readonly driver: ProviderDriverKind;
  readonly window: LimitPoolWindow;
  readonly label?: string;
  readonly now: number;
}) {
  const label = labelOverride ?? window.label;
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const left = window.remainingPercent;
  const accounts = window.members.length;
  const from = poolSources(window);
  const sourceLabels = [...from.hubs, ...(from.signedIn ? [gt("Signed-in accounts")] : [])];
  const next = nextPoolReset(window, now);
  const resetsAt = next?.member.window.resetsAt;
  const reset =
    next && resetsAt
      ? {
          duration: formatDuration(next.at - now, m),
          time: formatUpcomingTimestamp(resetsAt, timestampFormat, now, undefined, m),
        }
      : null;
  const windows = window.members.map((member) => member.window);
  const projects = projectsLimitWindow(driver, window.id);
  const projection = projects ? projectLimitWindows(windows, now) : null;
  const pooled = accounts > 1;
  const measuring = !projection && pooled && projects ? measuringNote(windows, m) : null;
  return (
    <UsageRow
      label={label}
      fill={left}
      tone={limitTone(left)}
      projection={projection}
      value={`${left}%`}
      ariaValue={
        pooled
          ? gt("{left}% left across {accounts} pooled accounts", { left, accounts })
          : gt("{left}% left", { left })
      }
      opensUsage
      tooltip={
        <>
          <span className="text-foreground">
            {pooled
              ? gt("{label}: {left}% left across {accounts} accounts", { label, left, accounts })
              : gt("{label}: {left}% left", { label, left })}
          </span>
          {next && reset ? (
            <span className="text-muted-foreground">
              {pooled
                ? gt("+{percent}% in {duration} · {time}", {
                    percent: next.restoresPercent,
                    ...reset,
                  })
                : gt("Resets in {duration} · {time}", reset)}
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
            <span className="text-muted-foreground">{m(PACE_LABEL[window.pace])}</span>
          ) : null}
          {sourceLabels.length > 0 ? (
            <span className="text-muted-foreground">
              {gt("From {sources}", { sources: sourceLabels.join(", ") })}
            </span>
          ) : null}
          {pooled ? (
            <span className="mt-1 grid grid-cols-[auto_auto_1fr] items-center gap-x-2 gap-y-0.5 border-t border-border/60 pt-1.5 tabular-nums">
              {window.members.map((member) => {
                const memberResetsAt = member.window.resetsAt
                  ? Date.parse(member.window.resetsAt)
                  : null;
                return (
                  <Fragment key={member.account.key}>
                    <AccountMark account={member.account} />
                    <span className="text-end text-foreground">
                      {remainingPercent(member.window)}%
                    </span>
                    <span className="text-muted-foreground">
                      {memberResetsAt !== null && memberResetsAt > now
                        ? gt("refills in {duration}", {
                            duration: formatDuration(memberResetsAt - now, m),
                          })
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
function measuringNote(
  windows: readonly ServerProviderUsageWindow[],
  resolve: MessageResolver,
): string | null {
  if (windows.every(measuredOverWindow)) return null;
  const windowDays = Math.max(...windows.map((window) => window.windowDurationMins ?? 0)) / 1440;
  if (windowDays < 1) return null;
  const days = Math.min(...windows.map((window) => window.recentSpend?.hours ?? 0)) / 24;
  return resolve(
    msg("Measuring the pool's pace before forecasting: {days} of {windowDays} days read", {
      days: Math.floor(days),
      windowDays: Math.round(windowDays),
    }),
  );
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
  const gt = useGT();
  const m = useMessages();
  const paces = projectionPaces(windows, now);
  const [dry] = projection.dry;
  const dryTotal = projection.dry.reduce((sum, stretch) => sum + stretch.until - stretch.from, 0);
  const expiring = projection.expiring.toSorted((a, b) => b.percent - a.percent).slice(0, 2);
  const safe = Math.floor(paces.safe * 10) / 10;
  const measuredHours = windows.every(measuredOverWindow)
    ? Math.min(...windows.map((window) => window.recentSpend!.hours))
    : null;
  const measuredDays = measuredHours === null ? null : Math.round(measuredHours / 24);
  const pooledAccounts = accounts !== undefined && accounts.length > 1;
  return (
    <>
      {dry ? (
        <span className="text-warning-foreground">
          {accounts ? (
            <T>
              Runs out in <Var>{formatDuration(dry.from - now, m)}</Var>,{" "}
              <Var>{formatDuration(dry.until - dry.from, m)}</Var> before{" "}
              <Var>
                <AccountMark account={accounts[dry.refill]!} />
              </Var>{" "}
              refills
            </T>
          ) : (
            <T>
              Runs out in <Var>{formatDuration(dry.from - now, m)}</Var>,{" "}
              <Var>{formatDuration(dry.until - dry.from, m)}</Var> before it resets
            </T>
          )}
          {projection.dry.length > 1 ? (
            <>
              {". "}
              <T>
                <Var>{formatDuration(dryTotal, m)}</Var> with no room in all
              </T>
            </>
          ) : null}
        </span>
      ) : null}
      {expiring.map((entry) => (
        <span key={entry.member} className="text-foreground">
          {accounts ? (
            <T>
              <Var>{Math.round(entry.percent)}</Var>% of{" "}
              <Var>
                <AccountMark account={accounts[entry.member]!} />
              </Var>{" "}
              resets unused in <Var>{formatDuration(entry.at - now, m)}</Var>
            </T>
          ) : (
            <T>
              <Var>{Math.round(entry.percent)}</Var>% resets unused in{" "}
              <Var>{formatDuration(entry.at - now, m)}</Var>
            </T>
          )}
        </span>
      ))}
      {!dry && expiring.length === 0 ? (
        <span className="text-foreground">
          {accounts ? (
            <T>Lasts until the refills, with nothing left over</T>
          ) : (
            <T>Lasts until the reset, with nothing left over</T>
          )}
        </span>
      ) : null}
      <span className="text-muted-foreground">
        {dry
          ? safe > 0
            ? gt("Slowing to {safe}× this pace keeps you covered", { safe })
            : gt("Even a crawl runs dry first")
          : paces.safe >= 3
            ? gt("Covered even at 3× this pace")
            : gt("Covered up to {safe}× this pace", { safe })}
      </span>
      {measuredHours !== null && measuredDays !== null ? (
        <span className="text-muted-foreground">
          {measuredHours < 24
            ? pooledAccounts
              ? gt("This pace is what the accounts spent over the last {duration}", {
                  duration: formatDuration(measuredHours * 3_600_000, m),
                })
              : gt("This pace is what the account spent over the last {duration}", {
                  duration: formatDuration(measuredHours * 3_600_000, m),
                })
            : pooledAccounts
              ? gt(
                  "{days, plural, =1 {This pace is what the accounts spent over the last day} other {This pace is what the accounts spent over the last {days} days}}",
                  { days: measuredDays },
                )
              : gt(
                  "{days, plural, =1 {This pace is what the account spent over the last day} other {This pace is what the account spent over the last {days} days}}",
                  { days: measuredDays },
                )}
        </span>
      ) : null}
      {paces.usesAll !== null ? (
        <span className="text-muted-foreground">
          {gt("At {pace}× this pace, nothing resets unused", {
            pace: Math.ceil(paces.usesAll * 10) / 10,
          })}
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

/** One label, hairline, and value row; the whole row opens the details tooltip. With `opensUsage` it links to the usage page. */
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
  opensUsage = false,
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
  readonly opensUsage?: boolean;
}) {
  const gt = useGT();
  const solid = projection ? projection.usePercent : (fill ?? 0);
  const need = projection ? Math.min(100, solid + projection.shortPercent) : null;
  const notch = need === null ? null : notchAt(need);
  const rowProps = {
    "aria-label": gt("{label}: {value}", { label, value: ariaValue }),
    className: cn(
      "col-span-3 grid h-6 grid-cols-subgrid items-center rounded-lg px-2.5 outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-black/[0.035] dark:hover:bg-white/[0.08] dark:data-popup-open:bg-white/[0.08]",
      opensUsage
        ? "group cursor-pointer active:bg-black/[0.06] dark:active:bg-white/[0.12]"
        : "cursor-default",
    ),
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          opensUsage ? <Link to="/usage" {...rowProps} /> : <div tabIndex={0} {...rowProps} />
        }
      >
        <span className="max-w-28 truncate text-muted-foreground group-hover:text-foreground">
          {label}
        </span>
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
                className="absolute -top-[3px] h-[9px] w-px -translate-x-1/2 bg-foreground/75"
                style={{ left: `clamp(0.5px, ${tick}%, calc(100% - 0.5px))` }}
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
        <div className="flex flex-col gap-0.5">
          {tooltip}
          {opensUsage ? <span className="text-muted-foreground">{gt("Open usage")}</span> : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
