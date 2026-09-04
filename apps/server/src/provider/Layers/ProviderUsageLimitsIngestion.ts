/**
 * ProviderUsageLimitsIngestionLive — folds `account.rate-limits.updated`
 * runtime events into the owning instance's published snapshot.
 *
 * Adapters normalise their native payloads before emitting, so this layer
 * never sees a driver shape: it routes the typed update to the instance and
 * lets `ServerProviderShape.applyUsageLimits` merge and republish on the
 * instance's own change stream, which `ProviderRegistry` already aggregates.
 *
 * @module provider/Layers/ProviderUsageLimitsIngestion
 */
import { ProviderUsageLimitsUpdate } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";

import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";

export const ProviderUsageLimitsIngestionLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const instanceRegistry = yield* ProviderInstanceRegistry;

    yield* providerService.streamEvents.pipe(
      Stream.filter((event) => event.type === "account.rate-limits.updated"),
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (!event.providerInstanceId) {
            return;
          }
          const instance = yield* instanceRegistry.getInstance(event.providerInstanceId);
          if (!instance) {
            return;
          }
          const limits = event.payload.rateLimits;
          if (!Schema.is(ProviderUsageLimitsUpdate)(limits)) return;
          const checkedAt = DateTime.formatIso(yield* DateTime.now);
          yield* instance.snapshot.applyUsageLimits({ ...limits, checkedAt });
          // One bad event must not end the subscriber for every later one.
        }).pipe(Effect.ignoreCause({ log: true })),
      ),
      Effect.forkScoped,
    );
  }),
);
