import { describe, expect, it } from "@effect/vitest";
import { UsageLimitSourceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** A hub with one Claude account whose quota reads answer with `statuses` in turn. */
function hubLayer(statuses: Array<{ status: number; retryAfter?: string }>) {
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      if (request.url.endsWith("/auth-files")) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            files: [{ id: "work.json", auth_index: "w", provider: "claude", email: "w@x.test" }],
          }),
        );
      }
      const next = statuses.shift()!;
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          status_code: next.status,
          header: next.retryAfter ? { "Retry-After": [next.retryAfter] } : null,
          body: encodeJson({ seven_day: { utilization: 14, resets_at: "2099-01-01T00:00:00Z" } }),
        }),
      );
    }),
  );
  return UsageLimitSources.layer.pipe(
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
      ),
    ),
  );
}

const firstSnapshot = Effect.gen(function* () {
  const sources = yield* UsageLimitSources.UsageLimitSources;
  return yield* sources.streamChanges.pipe(
    Stream.filter((snapshots) => snapshots.length > 0),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
});

describe("UsageLimitSources", () => {
  it.effect("keeps a throttled account's last reading and waits out its Retry-After", () => {
    const statuses = [{ status: 200 }, { status: 429, retryAfter: "600" }, { status: 200 }];
    return Effect.gen(function* () {
      const sources = yield* UsageLimitSources.UsageLimitSources;
      const read = yield* firstSnapshot;
      const windows = read[0]?.accounts[0]?.usageLimits.windows;
      expect(windows).toHaveLength(1);

      yield* TestClock.adjust("31 seconds");
      yield* sources.refresh;
      const throttled = (yield* sources.current)[0]?.accounts[0]?.usageLimits;
      expect(throttled?.windows).toEqual(windows);
      expect(throttled?.rateLimitedUntil).toBe("1970-01-01T00:10:31.000Z");

      // Read again only once the hub's provider allows it.
      yield* TestClock.adjust("5 minutes");
      yield* sources.refresh;
      expect(statuses).toHaveLength(1);
      yield* TestClock.adjust("5 minutes");
      yield* sources.refresh;
      expect(statuses).toEqual([]);
      expect((yield* sources.current)[0]?.accounts[0]?.usageLimits.rateLimitedUntil).toBe(
        undefined,
      );
    }).pipe(Effect.provide(hubLayer(statuses)));
  });

  it.effect("reuses a hub read from the last 30 seconds", () => {
    const statuses = [{ status: 200 }, { status: 200 }];
    return Effect.gen(function* () {
      const sources = yield* UsageLimitSources.UsageLimitSources;
      yield* firstSnapshot;
      yield* sources.refresh;
      expect(statuses).toHaveLength(1);
      yield* TestClock.adjust("30 seconds");
      yield* sources.refresh;
      expect(statuses).toEqual([]);
    }).pipe(Effect.provide(hubLayer(statuses)));
  });
});
