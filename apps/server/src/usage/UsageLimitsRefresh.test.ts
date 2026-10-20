import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import * as SessionStore from "../auth/SessionStore.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";
import * as UsageLimitsRefresh from "./UsageLimitsRefresh.ts";

describe("UsageLimitsRefresh", () => {
  it.effect("reads every two minutes while a client is connected, probing only on request", () =>
    Effect.gen(function* () {
      const connected = yield* Ref.make(false);
      const reads = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (read: string) => Ref.update(reads, (all) => [...all, read]);
      const layer = UsageLimitsRefresh.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(UsageLimitSources.UsageLimitSources)({ refresh: record("hub") }),
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              refreshUsageLimits: ({ probeFallback }) =>
                record(probeFallback ? "providers+probe" : "providers").pipe(Effect.as([])),
            }),
            Layer.mock(SessionStore.SessionStore)({
              cookieName: "t3_session",
              legacyCookieName: undefined,
              hasConnectedSession: Ref.get(connected),
            }),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const refresh = yield* UsageLimitsRefresh.UsageLimitsRefresh;
        yield* TestClock.adjust("2 minutes");
        expect(yield* Ref.get(reads)).toEqual([]);

        yield* Ref.set(connected, true);
        yield* TestClock.adjust("2 minutes");
        expect(yield* Ref.get(reads)).toEqual(["hub", "providers"]);

        yield* refresh.refresh;
        expect((yield* Ref.get(reads)).slice(2)).toEqual(["hub", "providers+probe"]);
      }).pipe(Effect.provide(layer));
    }),
  );
});
