/**
 * UsageLimitsRefresh — when subscription limits are re-read. A quota read is
 * one HTTP request per account, so it runs on its own schedule instead of
 * riding on provider status probes, which start CLIs and only run while a
 * client is in the foreground.
 *
 * Every two minutes while any client is connected, the hubs and every
 * provider that can read its quota directly are read. A refresh a client
 * asks for also probes the providers that report limits only from their
 * status probe. A read within 30 seconds of the last one, or of an account
 * the provider throttled, reuses the reading.
 *
 * @module usage/UsageLimitsRefresh
 */
import type { ServerProvider } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

export class UsageLimitsRefresh extends Context.Service<
  UsageLimitsRefresh,
  {
    /** Re-read every limit this environment reports. Never fails; failures land on the snapshots. */
    readonly refresh: Effect.Effect<ReadonlyArray<ServerProvider>>;
  }
>()("t3/usage/UsageLimitsRefresh") {}

export const USAGE_LIMITS_REFRESH_INTERVAL = Duration.minutes(2);

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sources = yield* UsageLimitSources.UsageLimitSources;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;

  const read = (probeFallback: boolean) =>
    Effect.all([sources.refresh, registry.refreshUsageLimits({ probeFallback })], {
      concurrency: 2,
    }).pipe(Effect.map(([, providers]) => providers));

  // Any connected client, not only a focused one: the reads are cheap, and
  // limits should be current the moment the user looks.
  yield* Effect.sleep(USAGE_LIMITS_REFRESH_INTERVAL).pipe(
    Effect.andThen(backgroundPolicy.hasDemand({ type: "provider-status" })),
    Effect.flatMap((connected) => (connected ? read(false) : Effect.void)),
    Effect.forever,
    Effect.forkScoped,
  );

  return { refresh: read(true) } satisfies UsageLimitsRefresh["Service"];
});

export const layer = Layer.effect(UsageLimitsRefresh, make);
