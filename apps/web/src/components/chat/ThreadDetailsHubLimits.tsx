import type {
  ProviderDriverKind,
  ServerProvider,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  displayLimitWindows,
  type LimitAccount,
  type LimitPoolMember,
  type LimitPoolWindow,
  type LimitProjection,
  measuredOverWindow,
  projectionPaces,
  projectLimitWindows,
  projectsLimitWindow,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { cursorUsageWindowDetails, formatDuration } from "@t3tools/shared/usageLimitsCopy";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { Fragment, type ReactNode } from "react";

import type { MessageResolver } from "~/i18n/messages";
import { cn } from "../../lib/utils";
import { providerClients } from "../settings/providerDriverMeta";
import { AccountChip } from "../usage/UsageLimitsPooled";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  type limitTone,
  nextPoolReset,
  otherDriverPools,
  poolSources,
} from "./ThreadDetailsUsage.logic";

/** A limit row's pool, projected at the pace it spends (patches/thread-details-hub-limits.md). */
export interface LimitForecast {
  readonly windows: readonly ServerProviderUsageWindow[];
  /** A pool's accounts, when it has more than one. */
  readonly members: readonly LimitPoolMember[];
  readonly projection: LimitProjection | null;
  /** A pool that projects once the server has measured its spend. */
  readonly measuring: boolean;
}

/** The forecast for one of the selected provider's rows; a pooled row carries its pool's members. */
export function limitForecast(
  driver: ProviderDriverKind | undefined,
  window: ServerProviderUsageWindow,
  pools: readonly LimitPoolWindow[] | undefined,
  now: number,
): LimitForecast {
  const pool = pools?.find((pooled) => pooled.kind === window.kind && pooled.id === window.id);
  return pool ? poolForecast(driver, pool, now) : forecastOf(driver, window.id, [window], [], now);
}

function poolForecast(
  driver: ProviderDriverKind | undefined,
  pool: LimitPoolWindow,
  now: number,
): LimitForecast {
  const windows = pool.members.map((member) => member.window);
  return forecastOf(driver, pool.id, windows, pool.members, now);
}

function forecastOf(
  driver: ProviderDriverKind | undefined,
  windowId: string,
  windows: readonly ServerProviderUsageWindow[],
  members: readonly LimitPoolMember[],
  now: number,
): LimitForecast {
  const projects = driver !== undefined && projectsLimitWindow(driver, windowId);
  const projection = projects ? projectLimitWindows(windows, now) : null;
  const pooled = members.length > 1;
  return {
    windows,
    members: pooled ? members : [],
    projection,
    measuring: projects && projection === null && pooled,
  };
}

/** One of another provider's rows, in the props `LimitRow` takes. */
export interface OtherDriverLimitRow {
  readonly window: ServerProviderUsageWindow;
  readonly pooledAccounts: number;
  readonly sources: readonly string[];
  readonly forecast: LimitForecast;
}

export interface OtherDriverLimitGroup {
  readonly driver: ProviderDriverKind;
  readonly rows: readonly OtherDriverLimitRow[];
}

/** Every other provider's limits on the environment, pooled like Usage → Limits. */
export function useOtherDriverLimits(
  driver: ProviderDriverKind | undefined,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): readonly OtherDriverLimitGroup[] {
  const gt = useGT();
  const m = useMessages();
  return otherDriverPools(driver ?? null, providers, sources, now).map((pool) => ({
    driver: pool.driver,
    rows: displayLimitWindows(pool).map((pooled) => {
      const from = poolSources(pooled);
      const cursorLabel =
        pool.driver === "cursor" ? cursorUsageWindowDetails(pooled.id, pool, m)?.label : null;
      return {
        // The same row ThreadDetailsUsage builds for a pooled window of the selected provider.
        window: {
          id: pooled.id,
          kind: pooled.kind,
          label: cursorLabel ?? pooled.label,
          usedPercent: 100 - pooled.remainingPercent,
          resetsAt: nextPoolReset(pooled, now)?.member.window.resetsAt,
        },
        pooledAccounts: pooled.members.length,
        sources: [...from.hubs, ...(from.signedIn ? [gt("Signed-in accounts")] : [])],
        forecast: poolForecast(pool.driver, pooled, now),
      };
    }),
  }));
}

export function OtherDriverLimits({
  groups,
  renderRow,
}: {
  readonly groups: readonly OtherDriverLimitGroup[];
  readonly renderRow: (row: OtherDriverLimitRow) => ReactNode;
}) {
  return groups.map((group) => (
    <Fragment key={group.driver}>
      <DriverCaption driver={group.driver} />
      {group.rows.map((row) => (
        <Fragment key={`${row.window.kind}:${row.window.id}`}>{renderRow(row)}</Fragment>
      ))}
    </Fragment>
  ));
}

/** Names the provider whose limits follow. */
export function DriverCaption({ driver }: { readonly driver: ProviderDriverKind | undefined }) {
  if (driver === undefined) return null;
  const label = providerClients.get(driver)?.label ?? String(driver);
  return (
    <div className="col-span-full grid h-7 min-w-0 grid-cols-subgrid items-center gap-x-1.5 text-caption text-muted-foreground select-none">
      <ProviderInstanceIcon
        driverKind={driver}
        displayName={label}
        className="size-4"
        iconClassName="size-3.5"
      />
      <span className="col-span-2 truncate">{label}</span>
    </div>
  );
}

const DASHES = "repeating-linear-gradient(90deg, currentColor 0 3px, transparent 3px 5px)";

// A slot cut around the notch, as on the Usage page, so it reads apart from a fill's end.
function notchAt(percent: number) {
  const at = `clamp(3px, ${percent}%, calc(100% - 3px))`;
  const [left, right] = [`calc(${at} - 3px)`, `calc(${at} + 3px)`];
  const [near, far] = ["-1px", "calc(100% + 1px)"];
  return {
    left: at,
    clipPath: `polygon(${near} ${near}, ${left} ${near}, ${left} ${far}, ${right} ${far}, ${right} ${near}, ${far} ${near}, ${far} ${far}, ${near} ${far})`,
  };
}

/**
 * The usage bar split by the forecast: solid for room the pace uses, dashed for room that resets
 * unused, amber for room it is short. The notch marks what the pace needs and replaces the pace tick.
 */
export function ProjectedLimitBar({
  projection,
  tone,
}: {
  readonly projection: LimitProjection;
  readonly tone: ReturnType<typeof limitTone>;
}) {
  const solid = projection.usePercent;
  const need = Math.min(100, solid + projection.shortPercent);
  const notch = notchAt(need);
  return (
    <span className="relative h-1 min-w-12 flex-1">
      <span className="absolute inset-0" style={{ clipPath: notch.clipPath }}>
        <span className="absolute inset-0 rounded-full bg-muted-foreground/20" />
        {projection.expiresPercent > 0 ? (
          <span
            className="absolute inset-y-0 text-foreground/50"
            style={{
              left: `${solid}%`,
              width: `${projection.expiresPercent}%`,
              backgroundImage: DASHES,
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
                  : "bg-foreground opacity-80",
            )}
            style={{ width: `max(${solid}%, 2px)` }}
          />
        ) : null}
        {need > solid ? (
          <span
            className="absolute inset-y-0 rounded-full bg-warning opacity-55"
            style={{ left: `${solid}%`, width: `${need - solid}%` }}
          />
        ) : null}
      </span>
      <span
        aria-hidden
        className="absolute -top-[3px] h-2.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
        style={{ left: notch.left }}
      />
    </span>
  );
}

/** The forecast in words and a pool's accounts, at the end of a limit row's tooltip. */
export function LimitForecastLines({
  forecast,
  now,
}: {
  readonly forecast: LimitForecast | null | undefined;
  readonly now: number;
}) {
  const gt = useGT();
  const m = useMessages();
  if (!forecast) return null;
  const accounts = forecast.members.map((member) => member.account);
  const measuring = forecast.measuring ? measuringNote(forecast.windows, m) : null;
  return (
    <>
      {forecast.projection ? (
        <ProjectionLines
          windows={forecast.windows}
          projection={forecast.projection}
          now={now}
          {...(accounts.length > 0 ? { accounts } : {})}
        />
      ) : measuring ? (
        <span>{measuring}</span>
      ) : null}
      {forecast.members.length > 0 ? (
        <span className="mt-1 grid grid-cols-[auto_auto_1fr] items-center gap-x-2 gap-y-0.5 tabular-nums">
          {forecast.members.map((member) => {
            const resetsAt = member.window.resetsAt ? Date.parse(member.window.resetsAt) : null;
            return (
              <Fragment key={member.account.key}>
                <AccountMark account={member.account} />
                <span className="text-end text-foreground">{remainingPercent(member.window)}%</span>
                <span>
                  {resetsAt !== null && resetsAt > now
                    ? gt("refills in {duration}", { duration: formatDuration(resetsAt - now, m) })
                    : ""}
                </span>
              </Fragment>
            );
          })}
        </span>
      ) : null}
    </>
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
      <span>
        {dry
          ? safe > 0
            ? gt("Slowing to {safe}× this pace keeps you covered", { safe })
            : gt("Even a crawl runs dry first")
          : paces.safe >= 3
            ? gt("Covered even at 3× this pace")
            : gt("Covered up to {safe}× this pace", { safe })}
      </span>
      {measuredHours !== null && measuredDays !== null ? (
        <span>
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
        <span>
          {gt("At {pace}× this pace, nothing resets unused", {
            pace: Math.ceil(paces.usesAll * 10) / 10,
          })}
        </span>
      ) : null}
    </>
  );
}
