import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { AccountlessBuildError, requireAccountlessExpoConfig } from "./accountless-expo-config.ts";

it.effect("accepts the fork's config, where cloud settings are null, empty or absent", () =>
  Effect.gen(function* () {
    yield* requireAccountlessExpoConfig(`{
      "name": "T3 Code",
      "extra": {
        "clerk": { "publishableKey": null, "jwtTemplate": "  " },
        "relay": { "url": null },
        "observability": { "tracesUrl": "https://api.axiom.co/v1/traces" }
      }
    }`);
    yield* requireAccountlessExpoConfig(`{ "name": "T3 Code" }`);
  }),
);

it.effect("refuses a config that would turn on T3 Connect and names each setting", () =>
  Effect.gen(function* () {
    const error = yield* requireAccountlessExpoConfig(`{
      "extra": {
        "clerk": { "publishableKey": "pk_live_example", "jwtTemplate": null },
        "relay": { "url": "https://relay.example" }
      }
    }`).pipe(Effect.flip);

    assert.instanceOf(error, AccountlessBuildError);
    assert.deepStrictEqual(error.settings, ["extra.clerk.publishableKey", "extra.relay.url"]);
    assert.include(error.message, "T3CODE_CLERK_*");
  }),
);
