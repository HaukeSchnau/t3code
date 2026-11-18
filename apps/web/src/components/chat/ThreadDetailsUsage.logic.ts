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

function environmentPools(
  environmentId: EnvironmentId,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): readonly LimitPool[] {
  return collectLimitPools(
    collectLimitAccounts(
      new Map([
        [
          environmentId,
          {
            entry: { target: { label: "" } },
            serverConfig: { providers, usageLimitSources: sources },
          },
        ],
      ]),
    ),
    now,
  );
}

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
  return (
    environmentPools(environmentId, [], sources, now).find((pool) => pool.driver === driver) ?? null
  );
}

/** Every other driver's limits on the environment, pooled like Usage → Limits. */
export function otherDriverPools(
  environmentId: EnvironmentId,
  activeDriver: ServerProvider["driver"] | null,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): readonly LimitPool[] {
  return environmentPools(environmentId, providers, sources, now).filter(
    (pool) => pool.driver !== activeDriver && pool.windows.length > 0,
  );
}
