import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as SessionStore from "../auth/SessionStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";
import * as UsageLimitsRefresh from "./UsageLimitsRefresh.ts";

const recordReads = Effect.gen(function* () {
  const hubReads = yield* Ref.make(0);
  const providerReads = yield* Ref.make<ReadonlyArray<boolean>>([]);
  const connected = yield* Ref.make(true);
  const layer = Layer.mergeAll(
    Layer.mock(UsageLimitSources.UsageLimitSources)({
      refresh: Ref.update(hubReads, (count) => count + 1),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      refreshUsageLimits: ({ probeFallback }) =>
        Ref.update(providerReads, (reads) => [...reads, probeFallback]).pipe(Effect.as([])),
    }),
    Layer.mock(SessionStore.SessionStore)({
      cookieName: "t3_session",
      legacyCookieName: undefined,
      hasConnectedSession: Ref.get(connected),
    }),
  );
  return { hubReads, providerReads, connected, layer };
});

it.effect("reads every two minutes while a client is connected, and probes on request", () =>
  Effect.gen(function* () {
    const { hubReads, providerReads, connected, layer } = yield* recordReads;
    yield* Effect.gen(function* () {
      yield* UsageLimitsRefresh.make;
      yield* TestClock.adjust("2 minutes");
      expect(yield* Ref.get(hubReads)).toBe(1);
      expect(yield* Ref.get(providerReads)).toEqual([false]);

      yield* Ref.set(connected, false);
      yield* TestClock.adjust("2 minutes");
      expect(yield* Ref.get(hubReads)).toBe(1);

      yield* UsageLimitsRefresh.readUsageLimits({
        sources: yield* UsageLimitSources.UsageLimitSources,
        registry: yield* ProviderRegistry.ProviderRegistry,
        probeFallback: true,
      });
      expect(yield* Ref.get(hubReads)).toBe(2);
      expect(yield* Ref.get(providerReads)).toEqual([false, true]);
    }).pipe(Effect.provide(layer), Effect.scoped);
  }),
);
