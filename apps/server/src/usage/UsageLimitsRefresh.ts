/**
 * UsageLimitsRefresh — when subscription limits are re-read. A quota read is
 * one HTTP request per account, so it runs on its own schedule instead of
 * riding on provider status probes, which start CLIs and only run while a
 * client is in the foreground.
 *
 * Every two minutes while any client holds a WebSocket connection, the hubs
 * and every provider that can read its quota directly are read. Open
 * connections decide this rather than client activity leases, so a client that
 * reports no activity still sees current numbers. A refresh a client
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

import * as SessionStore from "../auth/SessionStore.ts";
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
  const sessions = yield* SessionStore.SessionStore;

  const read = (probeFallback: boolean) =>
    Effect.all([sources.refresh, registry.refreshUsageLimits({ probeFallback })], {
      concurrency: 2,
    }).pipe(Effect.map(([, providers]) => providers));

  yield* Effect.sleep(USAGE_LIMITS_REFRESH_INTERVAL).pipe(
    Effect.andThen(sessions.hasConnectedSession),
    Effect.flatMap((connected) => (connected ? read(false) : Effect.void)),
    Effect.forever,
    Effect.forkScoped,
  );

  return { refresh: read(true) } satisfies UsageLimitsRefresh["Service"];
});

export const layer = Layer.effect(UsageLimitsRefresh, make);
