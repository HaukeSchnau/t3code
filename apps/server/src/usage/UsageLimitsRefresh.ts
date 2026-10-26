/**
 * Re-reads subscription limits every two minutes while any client holds a WebSocket connection,
 * apart from provider status probes, which start CLIs and only run while a client is in the
 * foreground (patches/usage-limits-refresh.md). A read within 30 seconds of the last one, or of
 * an account the provider throttled, reuses the reading.
 */
import type { ServerProvider } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SessionStore from "../auth/SessionStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const USAGE_LIMITS_REFRESH_INTERVAL = Duration.minutes(2);

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

/** @public */
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
