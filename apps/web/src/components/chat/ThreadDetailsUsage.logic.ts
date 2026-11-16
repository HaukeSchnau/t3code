import type {
  EnvironmentId,
  ServerProvider,
  ServerProviderUsageLimits,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectLimitPools,
  type LimitPool,
} from "@t3tools/shared/usageLimits";

/**
 * The hub accounts of the provider's driver, pooled, for a provider that cannot report its own
 * limits, such as Claude sending through a CLIProxyAPI hub with the hub's API key.
 */
export function hubPoolFor(
  environmentId: EnvironmentId,
  driver: ServerProvider["driver"],
  limits: ServerProviderUsageLimits,
  sources: UsageLimitSourceSnapshots,
  now: number,
): LimitPool | null {
  if (limits.unavailable?.reason !== "unsupported") return null;
  const accounts = collectLimitAccounts(
    new Map([
      [
        environmentId,
        {
          entry: { target: { label: "" } },
          serverConfig: { providers: [], usageLimitSources: sources },
        },
      ],
    ]),
  ).filter((account) => account.driver === driver);
  return collectLimitPools(accounts, now)[0] ?? null;
}
