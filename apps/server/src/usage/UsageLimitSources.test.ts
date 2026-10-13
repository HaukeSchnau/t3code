import { describe, expect, it } from "@effect/vitest";
import { UsageLimitSourceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

describe("UsageLimitSources", () => {
  it.effect("keeps an account's last good reading when its next read is throttled", () =>
    Effect.gen(function* () {
      const statuses = [429, 200, 429];
      const http = HttpClient.make((request) =>
        Effect.sync(() =>
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              request.url.endsWith("/auth-files")
                ? {
                    files: [
                      { id: "work.json", auth_index: "w", provider: "claude", email: "w@x.test" },
                    ],
                  }
                : {
                    status_code: statuses.shift(),
                    body: encodeJson({
                      seven_day: { utilization: 14, resets_at: "2099-01-01T00:00:00Z" },
                    }),
                  },
            ),
          ),
        ),
      );
      const layer = UsageLimitSources.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, http),
            ServerSettings.layerTest({
              usageLimitSources: {
                [UsageLimitSourceId.make("hub")]: {
                  kind: "cliproxy",
                  url: "http://hub.test:8317",
                  managementKey: "management-secret",
                  enabled: true,
                },
              },
            }),
            Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const sources = yield* UsageLimitSources.UsageLimitSources;
        const initial = yield* sources.streamChanges.pipe(
          Stream.filter((snapshots) => snapshots.length > 0),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(initial[0]?.accounts[0]?.usageLimits.unavailable?.reason).toBe("probeFailed");

        yield* sources.refresh;
        const read = yield* sources.current;
        expect(read[0]?.accounts[0]?.usageLimits.windows).toHaveLength(1);

        yield* sources.refresh;
        expect(statuses).toEqual([]);
        expect(yield* sources.current).toEqual(read);
      }).pipe(Effect.provide(layer));
    }),
  );
});
