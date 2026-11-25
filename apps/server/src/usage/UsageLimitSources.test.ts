import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  SecretProviderId,
  ServerConfigStreamEvent,
  UsageLimitSourceId,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const encodeConfigEvent = Schema.encodeSync(ServerConfigStreamEvent);
const testFiles = ServerConfig.layerTest(process.cwd(), { prefix: "t3-usage-limit-sources-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
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
    // Only an http(s) hub URL names an endpoint an agent can be sent to.
    expect(snapshots.map((source) => source.origin)).toEqual([
      undefined,
      undefined,
      undefined,
      "https://hub.test:8317",
      undefined,
    ]);
    expect(snapshots[3]?.endpoint).toBe("https://hub.test:8317/team-a");
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
      Layer.succeed(SecretResolver.SecretResolver, {
        label: (provider) => Effect.succeed(provider),
        read: (references) => Effect.succeed(references.map(() => undefined)),
        invalidate: () => Effect.void,
      }),
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
            url: "https://hub.test:8317/team-a/management.html",
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
      testFiles,
    ]),
  ),
);

/**
 * A hub with one Claude account whose quota reads answer with `statuses` in turn. Tests change
 * `authFile` to stand for the hub rewriting the account's auth file, and `models` for the models
 * the hub routes to it.
 */
function hubDependencies(
  statuses: Array<{ status: number; retryAfter?: string; utilization?: number }>,
  authFile: { modtime?: string; email?: string | undefined } = {},
  models: Array<string> = [],
) {
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      if (request.url.endsWith("/auth-files")) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            files: [
              {
                id: "work.json",
                auth_index: "w",
                provider: "claude",
                email: "w@x.test",
                ...authFile,
              },
            ],
          }),
        );
      }
      if (request.url.includes("/auth-files/models")) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ models: models.map((id) => ({ id })) }),
        );
      }
      const next = statuses.shift()!;
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          status_code: next.status,
          header: next.retryAfter ? { "Retry-After": [next.retryAfter] } : null,
          body: encodeJson({
            seven_day: { utilization: next.utilization ?? 14, resets_at: "2099-01-01T00:00:00Z" },
          }),
        }),
      );
    }),
  );
  return Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, http),
    NodeCrypto.layer,
    Layer.succeed(SecretResolver.SecretResolver, {
      label: (provider) => Effect.succeed(provider),
      read: (references) => Effect.succeed(references.map(() => undefined)),
      invalidate: () => Effect.void,
    }),
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
    testFiles,
  );
}

function hubLayer(
  statuses: Array<{ status: number; retryAfter?: string }>,
  authFile: { modtime?: string; email?: string | undefined } = {},
  models: Array<string> = [],
) {
  return Layer.effect(UsageLimitSources.UsageLimitSources, UsageLimitSources.make).pipe(
    Layer.provide(hubDependencies(statuses, authFile, models)),
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

it.effect("lends a failed read only the last reading of the same login", () => {
  const statuses = [
    { status: 200 },
    { status: 429, retryAfter: "600" },
    { status: 429, retryAfter: "1" },
    { status: 200 },
    { status: 429, retryAfter: "1" },
  ];
  const authFile: { email?: string | undefined } = { email: "first@x.test" };
  const models = ["claude-opus-4-6"];
  const unread = { windows: [], unavailable: { reason: "probeFailed" } };
  return Effect.gen(function* () {
    const sources = yield* UsageLimitSources.UsageLimitSources;
    const read = Effect.gen(function* () {
      yield* TestClock.adjust("31 seconds");
      yield* sources.refresh;
      return (yield* sources.current)[0]?.accounts[0];
    });
    const windows = (yield* firstSnapshot)[0]?.accounts[0]?.usageLimits.windows;
    expect(windows).toHaveLength(1);
    // Only the reading is lent; the model list is the one the hub routes to the account now.
    models[0] = "claude-sonnet-4-6";
    expect(yield* read).toMatchObject({ models: ["claude-sonnet-4-6"], usageLimits: { windows } });
    // Auth file names can be reused: another login is read despite the last one's throttle.
    authFile.email = "second@x.test";
    expect(yield* read).toMatchObject({ email: "second@x.test", usageLimits: unread });
    // A file that lists no login cannot show whether the next one is the same.
    authFile.email = undefined;
    expect((yield* read)?.usageLimits.windows).toHaveLength(1);
    expect(yield* read).toMatchObject({ usageLimits: unread });
    expect(statuses).toEqual([]);
  }).pipe(Effect.provide(hubLayer(statuses, authFile, models)));
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

it.effect("stops reading a rejected account until the hub rewrites its auth file", () => {
  const statuses = [{ status: 200 }, { status: 401 }, { status: 200 }];
  const authFile = { modtime: "2026-11-08T17:46:20Z" };
  return Effect.gen(function* () {
    const sources = yield* UsageLimitSources.UsageLimitSources;
    yield* firstSnapshot;

    yield* TestClock.adjust("31 seconds");
    yield* sources.refresh;
    const rejected = (yield* sources.current)[0]?.accounts[0];
    expect(rejected?.signInRequired).toBe(true);
    // A login that cannot sign in has no usable quota, so the last reading is dropped.
    expect(rejected?.usageLimits.windows).toEqual([]);

    for (let refresh = 0; refresh < 5; refresh += 1) {
      yield* TestClock.adjust("2 minutes");
      yield* sources.refresh;
    }
    expect(statuses).toHaveLength(1);
    expect((yield* sources.current)[0]?.accounts[0]?.signInRequired).toBe(true);

    // A new login rewrites the auth file.
    authFile.modtime = "2026-11-09T13:48:48Z";
    yield* TestClock.adjust("2 minutes");
    yield* sources.refresh;
    expect(statuses).toEqual([]);
    const restored = (yield* sources.current)[0]?.accounts[0];
    expect(restored?.signInRequired).toBe(undefined);
    expect(restored?.usageLimits.windows).toHaveLength(1);
  }).pipe(Effect.provide(hubLayer(statuses, authFile)));
});

it.effect("reads a management key from its secret provider", () => {
  const authorizations: Array<string | undefined> = [];
  const keySource = (reference: string) => ({
    provider: SecretProviderId.make("homelab"),
    reference,
  });
  return Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    const snapshots = yield* sources.streamChanges.pipe(
      Stream.filter((next) => next.length > 0),
      Stream.runHead,
      Effect.flatMap(Effect.fromOption),
    );
    expect(snapshots.map(({ id, error }) => ({ id, error }))).toEqual([
      { id: "resolved-hub", error: undefined },
      {
        id: "unresolved-hub",
        error: "Could not read the management key from its secret provider.",
      },
    ]);
    expect(authorizations).toEqual(["Bearer resolved-key"]);
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("resolved-hub")]: {
            kind: "cliproxy",
            url: "https://resolved.test",
            managementKey: keySource("cliproxy#key"),
            enabled: true,
          },
          [UsageLimitSourceId.make("unresolved-hub")]: {
            kind: "cliproxy",
            url: "https://unresolved.test",
            managementKey: keySource("missing#key"),
            enabled: true,
          },
        },
      }),
      Layer.succeed(SecretResolver.SecretResolver, {
        label: (provider) => Effect.succeed(provider),
        read: (references) =>
          Effect.succeed(
            references.map((reference) =>
              reference.reference === "cliproxy#key" ? "resolved-key" : undefined,
            ),
          ),
        invalidate: () => Effect.void,
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            authorizations.push(request.headers.authorization);
            return HttpClientResponse.fromWeb(request, Response.json({ files: [] }));
          }),
        ),
      ),
      NodeCrypto.layer,
      testFiles,
    ]),
    Effect.scoped,
  );
});

it.effect("measures nothing from a failed read that keeps the last reading", () => {
  const statuses = [{ status: 200 }, { status: 429, retryAfter: "60" }];
  return Effect.gen(function* () {
    const sources = yield* UsageLimitSources.UsageLimitSources;
    yield* firstSnapshot;
    yield* TestClock.adjust("25 hours");
    yield* sources.refresh;
    const window = (yield* sources.current)[0]?.accounts[0]?.usageLimits.windows[0];
    expect(window?.usedPercent).toBe(14);
    expect(window?.recentSpend).toBeUndefined();
  }).pipe(Effect.provide(hubLayer(statuses)));
});

it.effect("measures an account's pace from readings kept across a restart", () => {
  const firstWindow = Effect.scoped(
    UsageLimitSources.make.pipe(
      Effect.flatMap((sources) =>
        sources.streamChanges.pipe(
          Stream.filter((snapshots) => snapshots.length > 0),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        ),
      ),
      Effect.map((snapshots) => snapshots[0]?.accounts[0]?.usageLimits.windows[0]),
    ),
  );
  return Effect.gen(function* () {
    expect((yield* firstWindow)?.recentSpend).toBeUndefined();
    yield* TestClock.adjust("25 hours");
    expect((yield* firstWindow)?.recentSpend).toEqual({ percentPerHour: 12 / 25, hours: 25 });
  }).pipe(
    Effect.provide(
      hubDependencies([
        { status: 200, utilization: 14 },
        { status: 200, utilization: 26 },
      ]),
    ),
  );
});

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const at = (hours: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW + hours * 3_600_000));
const spent = (id: string, hours: number): ServerProviderUsageWindow => ({
  id,
  kind: "weekly",
  label: id,
  usedPercent: 100,
  resetsAt: at(hours),
});
const hub = (
  accounts: ReadonlyArray<{
    driver?: string;
    models?: ReadonlyArray<string>;
    windows?: ReadonlyArray<ServerProviderUsageWindow>;
    unavailable?: true;
  }>,
): UsageLimitSourceSnapshot => ({
  id: UsageLimitSourceId.make("hub"),
  kind: "cliproxy",
  label: "hub",
  checkedAt: at(0),
  accounts: accounts.map((account, index) => ({
    id: `account-${index}`,
    driver: ProviderDriverKind.make(account.driver ?? "claudeAgent"),
    ...(account.models ? { models: account.models } : {}),
    usageLimits: {
      checkedAt: at(0),
      windows: account.windows ?? [],
      ...(account.unavailable ? { unavailable: { reason: "probeFailed" as const } } : {}),
    },
  })),
});

it.each([
  {
    name: "earliest refill when every account is spent, each at its latest spent window",
    accounts: [
      { windows: [spent("five_hour", 1), spent("seven_day", 3)] },
      { windows: [spent("five_hour", 2)] },
      { driver: "codex", windows: [] },
    ],
    model: "claude-haiku-5-5",
    expected: at(2),
  },
  {
    name: "unknown while an account still has room",
    accounts: [{ windows: [spent("five_hour", 1)] }, { windows: [] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "unknown while an account could not be read",
    accounts: [{ windows: [spent("five_hour", 1)] }, { unavailable: true as const }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "unknown when a spent window has no reset or already reset",
    accounts: [{ windows: [{ ...spent("five_hour", 1), resetsAt: undefined }] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "a model-scoped weekly window blocks only its own model",
    accounts: [{ windows: [spent("seven_day_fable", 5)] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "a model-scoped weekly window blocks its own model",
    accounts: [{ windows: [spent("seven_day_fable", 5)] }],
    model: "claude-fable-5-2",
    expected: at(5),
  },
  {
    name: "no account of the driver",
    accounts: [{ driver: "codex", windows: [spent("five_hour", 1)] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  // regression: #30778 only the accounts the hub routes the model to can refill it
  {
    name: "an account of another driver the hub routes the model to counts",
    accounts: [
      { driver: "codex", models: ["gpt-5.6-sol"], windows: [spent("five_hour", 3)] },
      { models: ["claude-sonnet-4-6"], windows: [] },
    ],
    model: "gpt-5.6-sol",
    expected: at(3),
  },
  {
    name: "an account that lists no models is left out of an alias",
    accounts: [{ windows: [spent("five_hour", 1)] }, { models: [], windows: [] }],
    model: "opus",
    expected: at(1),
  },
  {
    name: "a spent Gemini quota does not hold back Claude on Antigravity",
    accounts: [
      {
        driver: "antigravity",
        models: ["claude-opus-4-6-thinking"],
        windows: [spent("3p-5h", 1), spent("gemini-5h", 24)],
      },
    ],
    model: "claude-opus-4-6-thinking",
    expected: at(1),
  },
  {
    name: "a hub thinking suffix routes by its base model",
    accounts: [
      { driver: "codex", models: ["gpt-5.2"], windows: [spent("five_hour", 3)] },
      { models: ["claude-sonnet-4-6"], windows: [] },
    ],
    model: "gpt-5.2(high)",
    expected: at(3),
  },
  {
    name: "a prefixed Gemini model is held back by the Gemini quota",
    accounts: [
      {
        driver: "antigravity",
        models: ["ag/gemini-3.1-pro-high"],
        windows: [spent("3p-5h", 1), spent("gemini-5h", 24)],
      },
    ],
    model: "ag/gemini-3.1-pro-high",
    expected: at(24),
  },
  {
    name: "an alias of unknown family is held back by every Antigravity quota",
    accounts: [{ driver: "antigravity", models: ["fast"], windows: [spent("gemini-5h", 24)] }],
    model: "fast",
    expected: at(24),
  },
  {
    name: "an own-driver account whose model list was unread still counts",
    accounts: [
      { windows: [spent("five_hour", 1)] },
      {
        driver: "antigravity",
        models: ["claude-sonnet-4-6"],
        windows: [spent("3p-5h", 8)],
      },
    ],
    model: "claude-sonnet-4-6",
    expected: at(1),
  },
  {
    name: "an Argon model waits only for the Argon quota",
    accounts: [
      {
        driver: "antigravity",
        models: ["gemini-4-argon-high"],
        windows: [spent("gemini-argon-5h", 2), spent("gemini-carbon-weekly", 96)],
      },
    ],
    model: "gemini-4-argon-high",
    expected: at(2),
  },
])("hub pool reset: $name", ({ accounts, model, expected }) => {
  expect(
    UsageLimitSources.hubPoolResetAt(
      [hub(accounts)],
      ProviderDriverKind.make("claudeAgent"),
      model,
      NOW,
    ),
  ).toBe(expected);
});

it.effect("the reset fallback refreshes its hub, and a stalled hub cannot hold the failure", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const roomLeft = { ...hub([{ windows: [spent("five_hour", 2)] }]), origin: "http://hub.test" };
    const cached = {
      ...roomLeft,
      accounts: roomLeft.accounts.map((account) => ({
        ...account,
        usageLimits: {
          ...account.usageLimits,
          windows: account.usageLimits.windows.map((window) => ({ ...window, usedPercent: 99 })),
        },
      })),
    };
    let current: ReadonlyArray<UsageLimitSourceSnapshot> = [cached];
    let refresh: Effect.Effect<void> = Effect.sync(() => {
      current = [roomLeft];
    });
    const lookup = UsageLimitSources.UsageLimitResetFallback.pipe(
      Effect.flatMap((fallback) =>
        fallback.resetAt(ProviderDriverKind.make("claudeAgent"), "http://hub.test", null),
      ),
      Effect.provide(
        UsageLimitSources.layerResetFallback.pipe(
          Layer.provide(
            Layer.mock(UsageLimitSources.UsageLimitSources)({
              current: Effect.sync(() => current),
              refresh: Effect.suspend(() => refresh),
            }),
          ),
        ),
      ),
    );
    // The last poll saw room; the account was spent after it.
    expect(yield* lookup).toBe(at(2));
    current = [cached];
    refresh = Effect.never;
    const stalled = yield* Effect.forkChild(lookup);
    yield* TestClock.adjust("5 seconds");
    expect(yield* Fiber.join(stalled)).toBeNull();
  }),
);
