import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ServerConfigStreamEvent, UsageLimitSourceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const encodeConfigEvent = Schema.encodeSync(ServerConfigStreamEvent);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect("keeps malformed source URLs encodable for config subscribers", () =>
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const snapshots = yield* sources.current;
    expect(snapshots.map((source) => source.label)).toEqual([
      "local-hub",
      "opaque-hub",
      "Named hub",
      "hub.test:8317",
      "Usage limit source",
    ]);
    expect(() =>
      encodeConfigEvent({
        version: 1,
        type: "usageLimitSourcesUpdated",
        payload: { sources: snapshots },
      }),
    ).not.toThrow();
    expect(snapshots.every((source) => source.error === "No management key configured.")).toBe(
      true,
    );
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("local-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("opaque-hub")]: {
            kind: "cliproxy",
            url: "file:///tmp/hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("named-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            label: "Named hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("valid-hub")]: {
            kind: "cliproxy",
            url: "https://hub.test:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make(" ")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
        },
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected network request")),
      ),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  ),
);

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
        NodeCrypto.layer,
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
    expect((yield* sources.current)[0]?.accounts[0]?.usageLimits.rateLimitedUntil).toBe(undefined);
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
