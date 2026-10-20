/**
 * When subscription limits are re-read (patches/usage-limits-refresh.md). A
 * quota read is one HTTP request per account, so it runs on its own schedule
 * instead of riding on provider status probes, which start CLIs and only run
 * while a client is in the foreground.
 *
 * Every two minutes while any client holds a WebSocket connection, the hubs
 * and every provider that can read its quota directly are read, whatever the
 * provider health check interval. Open connections decide this rather than
 * client activity leases, so a client that reports no activity still sees
 * current numbers. A refresh a client asks for also probes the providers that
 * report limits only from their status probe (`readUsageLimits` with
 * `probeFallback`). A read within 30 seconds of the last one, or of an account
 * the provider throttled, reuses the reading.
 */
import type { ServerProvider } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SessionStore from "../auth/SessionStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

export const USAGE_LIMITS_REFRESH_INTERVAL = Duration.minutes(2);

/** Re-reads every limit this environment reports. Never fails; failures land on the snapshots. */
export const readUsageLimits = (input: {
  readonly sources: UsageLimitSources.UsageLimitSources["Service"];
  readonly registry: ProviderRegistry.ProviderRegistry["Service"];
  readonly probeFallback: boolean;
}): Effect.Effect<ReadonlyArray<ServerProvider>> =>
  Effect.all(
    [
      input.sources.refresh,
      input.registry.refreshUsageLimits({ probeFallback: input.probeFallback }),
    ],
    { concurrency: 2 },
  ).pipe(Effect.map(([, providers]) => providers));

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sources = yield* UsageLimitSources.UsageLimitSources;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const sessions = yield* SessionStore.SessionStore;

  yield* Effect.sleep(USAGE_LIMITS_REFRESH_INTERVAL).pipe(
    Effect.andThen(sessions.hasConnectedSession),
    Effect.flatMap((connected) =>
      connected ? readUsageLimits({ sources, registry, probeFallback: false }) : Effect.void,
    ),
    Effect.forever,
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(make);
