import type {
  ProviderConsumeResetCreditInput,
  ServerProviderResetCredits,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import {
  collectExternalUsageLinks as collectExternalUsageLinksWith,
  cursorUsageWindowDetails as cursorUsageWindowDetailsBase,
  type LimitPool,
  type LimitPresentations,
  projectRunOut,
  providersWithLimits,
  type ResetCreditChoice,
  resetCountdown,
  throttledFor,
  unshownFailedHubAccounts,
} from "./usageLimits.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const CURSOR_USAGE_WINDOW_COPY: Readonly<
  Record<string, { readonly label: string; readonly description: string }>
> = {
  totalPercentUsed: {
    label: msg("Overall", { $context: "usage limit covering the whole plan" }),
    description: msg("All usage on your plan this billing cycle."),
  },
  autoPercentUsed: {
    label: msg("Cursor Models"),
    description: msg("Grok, Composer, and Auto use this allowance."),
  },
  apiPercentUsed: {
    label: msg("Other Models"),
    description: msg("Usage allowance for third-party models such as Claude, GPT, and Gemini."),
  },
};

/** @public */
export function cursorUsageWindowDetails(
  id: string,
  pool: LimitPool,
  resolve: MFunctionType = mFallback,
) {
  const details = cursorUsageWindowDetailsBase(id, pool);
  const copy = CURSOR_USAGE_WINDOW_COPY[id];
  if (!details || !copy) return details;
  return {
    ...details,
    label: details.label === null ? null : resolve(copy.label),
    description: details.description === undefined ? undefined : resolve(copy.description),
  };
}

/** @public */
export function collectExternalUsageLinks(
  presentations: LimitPresentations,
  resolve: MFunctionType = mFallback,
) {
  return collectExternalUsageLinksWith(presentations, (provider, environment) =>
    resolve(msg("{provider} on {environment}", { provider, environment })),
  );
}

/** @public */
export function limitsNotice(
  limits: ServerProviderUsageLimits,
  resolve: MFunctionType = mFallback,
): string | null {
  if (limits.unavailable?.reason === "unsupported") {
    return limits.unavailable.message ?? resolve(msg("This account has no subscription limits."));
  }
  if (limits.unavailable?.reason === "probeFailed") {
    return limits.unavailable.message ?? resolve(msg("Could not read limits."));
  }
  return limits.windows.length === 0 ? resolve(msg("No limits reported.")) : null;
}

function nextReadIn(waits: readonly number[], resolve: MFunctionType): string {
  return formatDuration(Math.ceil(Math.min(...waits) / MINUTE) * MINUTE, resolve);
}

/**
 * Reads the provider is throttling show their last reading and when the next read happens.
 * Hub accounts are counted, not named: the pooled views never print an account's email.
 * @public
 */
export function collectLimitNotices(
  presentations: LimitPresentations,
  now: number,
  resolve: MFunctionType = mFallback,
): readonly string[] {
  const label = (environmentLabel: string, subject: string) =>
    presentations.size > 1 ? `${environmentLabel} · ${subject}` : subject;
  const notices = new Set<string>();
  // A failed hub read needs no notice when another report already shows the account's row.
  const failedAccounts = unshownFailedHubAccounts(presentations);
  for (const presentation of presentations.values()) {
    const environmentLabel = presentation.entry.target.label;
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      const limits = provider.usageLimits;
      // A bare unsupported means the account has no limits; an external usage link shows its message.
      if (
        limits?.unavailable?.reason === "unsupported" &&
        (!limits.unavailable.message || limits.externalUsage)
      ) {
        continue;
      }
      const throttled = limits ? throttledFor(limits, now) : null;
      const notice =
        throttled !== null
          ? resolve(
              msg("Usage reads are rate-limited. Next read in {duration}.", {
                duration: nextReadIn([throttled], resolve),
              }),
            )
          : limits
            ? limitsNotice(limits, resolve)
            : null;
      const name = provider.displayName?.trim() || String(provider.driver);
      if (notice) notices.add(`${label(environmentLabel, name)}: ${notice}`);
    }
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      const subject = label(environmentLabel, source.label);
      if (source.error) {
        notices.add(`${subject}: ${source.error}`);
        continue;
      }
      if (source.accounts.length === 0) {
        notices.add(resolve(msg("{source}: No accounts reported.", { source: subject })));
        continue;
      }
      const throttled = source.accounts.flatMap((account) => {
        const wait = throttledFor(account.usageLimits, now);
        return wait === null ? [] : [wait];
      });
      const signedOut = source.accounts.filter((account) => account.signInRequired).length;
      const unread = source.accounts.filter(
        (account) =>
          !account.signInRequired &&
          failedAccounts.has(account) &&
          throttledFor(account.usageLimits, now) === null,
      ).length;
      if (signedOut > 0) {
        notices.add(
          resolve(
            msg(
              "{count, plural, one {{source}: {count} account needs a new sign-in on the hub.} other {{source}: {count} accounts need a new sign-in on the hub.}}",
              { source: subject, count: signedOut },
            ),
          ),
        );
      }
      if (unread > 0) {
        notices.add(
          resolve(
            msg(
              "{count, plural, one {{source}: Could not read {count} account.} other {{source}: Could not read {count} accounts.}}",
              { source: subject, count: unread },
            ),
          ),
        );
      }
      if (throttled.length > 0) {
        notices.add(
          resolve(
            msg(
              "{count, plural, one {{source}: Reads of {count} account are rate-limited. Next read in {duration}.} other {{source}: Reads of {count} accounts are rate-limited. Next read in {duration}.}}",
              {
                source: subject,
                count: throttled.length,
                duration: nextReadIn(throttled, resolve),
              },
            ),
          ),
        );
      }
    }
  }
  return [...notices];
}

/** @public */
export function formatDuration(ms: number, resolve: MFunctionType = mFallback): string {
  const remaining = Math.max(0, ms);
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  const minutes = Math.floor((remaining % HOUR) / MINUTE);
  if (days > 0) return resolve(msg("{days}d {hours}h", { days, hours }));
  if (hours > 0) return resolve(msg("{hours}h {minutes}m", { hours, minutes }));
  return resolve(msg("{minutes}m", { minutes }));
}

/** @public */
export function resetCreditChoices(
  credits: ServerProviderResetCredits,
  input: ProviderConsumeResetCreditInput,
  now: number,
  compact = false,
  resolve: MFunctionType = mFallback,
): ReadonlyArray<ResetCreditChoice> {
  const expiresIn = (at: string | undefined) =>
    at ? formatDuration(Date.parse(at) - now, resolve) : null;
  if (credits.options && "instanceId" in input) {
    return credits.options.map((option) => {
      const expires = expiresIn(option.expiresAt);
      const values = { label: option.label, count: option.availableCount };
      return {
        key: option.creditId,
        summary: expires
          ? resolve(msg("{label} · {count} left · expires in {expires}", { ...values, expires }))
          : resolve(msg("{label} · {count} left", values)),
        actionLabel: resolve(msg("Use", { $context: "button that redeems a reset credit" })),
        confirmDescription: resolve(
          msg("{label}: {description} This cannot be undone.", {
            label: option.label,
            description: option.description,
          }),
        ),
        availableCount: option.availableCount,
        input: { ...input, creditId: option.creditId },
      };
    });
  }
  const count = credits.availableCount;
  const expires = expiresIn(credits.nextExpiresAt);
  return [
    {
      key: "next",
      summary:
        count === 0
          ? resolve(msg("No reset credits banked"))
          : compact
            ? expires
              ? resolve(msg("{count} banked · expires in {expires}", { count, expires }))
              : resolve(msg("{count} banked", { count }))
            : expires
              ? resolve(
                  msg(
                    "{count, plural, one {{count} reset credit banked · next expires in {expires}} other {{count} reset credits banked · next expires in {expires}}}",
                    { count, expires },
                  ),
                )
              : resolve(
                  msg(
                    "{count, plural, one {{count} reset credit banked} other {{count} reset credits banked}}",
                    { count },
                  ),
                ),
      actionLabel: resolve(msg("Use reset")),
      confirmDescription: resolve(
        msg(
          "This redeems one credit on your account and clears the current rate-limit windows. It cannot be undone.",
        ),
      ),
      availableCount: count,
      input,
    },
  ];
}

/**
 * `full` reads "resets in 2h 5m", `in` reads "in 2h 5m", `refill` reads "↻ 2h 5m".
 * @public
 */
export function formatResetsIn(
  window: ServerProviderUsageWindow,
  now: number,
  resolve: MFunctionType = mFallback,
  style: "full" | "in" | "refill" = "full",
): string | null {
  const countdown = resetCountdown(window, now);
  if (countdown === null) return null;
  if (countdown.kind === "now") return resolve(msg("resets now"));
  if (countdown.kind === "momentarily") return resolve(msg("Resets momentarily"));
  const duration = formatDuration(countdown.ms, resolve);
  if (style === "in") {
    return resolve(
      msg("in {duration}", { duration, $context: "time until a usage window resets" }),
    );
  }
  if (style === "refill") return resolve(msg("↻ {duration}", { duration }));
  return resolve(msg("resets in {duration}", { duration }));
}

/** `runs out in about 40m`, or null when the window resets before it runs dry. */
export function formatRunsOutIn(
  window: ServerProviderUsageWindow,
  now: number,
  resolve: MFunctionType = mFallback,
): string | null {
  const runOut = projectRunOut(window, now);
  if (runOut === null) return null;
  if (runOut < MINUTE) return resolve(msg("runs out now"));
  return resolve(
    msg("runs out in about {duration}", { duration: formatDuration(runOut, resolve) }),
  );
}
