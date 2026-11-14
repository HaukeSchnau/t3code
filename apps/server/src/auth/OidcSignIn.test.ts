// @effect-diagnostics nodeBuiltinImport:off - The fake issuer signs ID tokens with node:crypto.
import * as NodeCrypto from "node:crypto";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
  EnvironmentId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as AuthHttp from "./http.ts";
import * as OidcSignIn from "./OidcSignIn.ts";
import {
  OidcSignInConfig,
  type OidcSignInSettings,
  parseOidcSignInEnv,
  satisfiesClaimRules,
} from "./OidcSignInConfig.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

class OidcTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.oidc) {}

const ISSUER = "https://id.example.test";
const SERVER = "https://box.example.test";
const CLIENT_ID = "t3-box";
const CLIENT_SECRET = "client-secret";

const settings: OidcSignInSettings = {
  issuer: ISSUER,
  clientId: CLIENT_ID,
  clientSecret: Redacted.make(CLIENT_SECRET),
  redirectUri: new URL(`${SERVER}/api/auth/oidc/callback`),
  label: "Schnau ID",
  returnOrigins: new Set([SERVER, "https://other.example.test"]),
  returnSchemes: new Set(["t3code:"]),
  require: [{ claim: "groups", value: "t3-owner" }],
};

/** What the fake issuer puts in the next ID token, relative to a valid one. */
interface IssuerBehavior {
  readonly claims?: Record<string, unknown>;
  readonly nonce?: string;
  readonly audience?: string;
  readonly signWith?: NodeCrypto.KeyObject;
}

const makeIssuer = () => {
  const signing = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = {
    ...signing.publicKey.export({ format: "jwk" }),
    kid: "k1",
    alg: "RS256",
    use: "sig",
  };
  const authorizations = new Map<string, URL>();
  let behavior: IssuerBehavior = {};
  const sign = (claims: Record<string, unknown>, key: NodeCrypto.KeyObject) => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const input = `${encode({ alg: "RS256", kid: "k1", typ: "JWT" })}.${encode(claims)}`;
    return `${input}.${NodeCrypto.sign("sha256", Buffer.from(input), key).toString("base64url")}`;
  };
  const json = (request: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown) =>
    HttpClientResponse.fromWeb(request, Response.json(body));
  const client = HttpClient.make((request) =>
    Effect.promise(async () => {
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/openid-configuration") {
        return json(request, {
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/auth`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/keys`,
        });
      }
      if (url.pathname === "/keys") return json(request, { keys: [jwk] });
      if (url.pathname === "/token" && request.body._tag === "Uint8Array") {
        const body = new URLSearchParams(new TextDecoder().decode(request.body.body));
        const authorization = authorizations.get(body.get("code") ?? "");
        const expectedBasic = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;
        const challenge = NodeCrypto.createHash("sha256")
          .update(body.get("code_verifier") ?? "")
          .digest("base64url");
        if (
          authorization === undefined ||
          request.headers.authorization !== expectedBasic ||
          body.get("redirect_uri") !== settings.redirectUri.toString() ||
          challenge !== authorization.searchParams.get("code_challenge")
        ) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ error: "invalid_grant" }, { status: 400 }),
          );
        }
        authorizations.delete(body.get("code") ?? "");
        const idToken = sign(
          {
            iss: ISSUER,
            aud: behavior.audience ?? CLIENT_ID,
            sub: "user-1",
            // 2100-01-01, so the token never expires under the test.
            exp: 4_102_444_800,
            nonce: behavior.nonce ?? authorization.searchParams.get("nonce"),
            email: "owner@example.test",
            groups: ["t3-owner", "family"],
            ...behavior.claims,
          },
          behavior.signWith ?? signing.privateKey,
        );
        return json(request, { access_token: "unused", token_type: "Bearer", id_token: idToken });
      }
      return HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }));
    }),
  );
  return {
    client,
    /** Approves an authorization request the way a provider would, returning its callback path. */
    approve: (authorizeUrl: string, next: IssuerBehavior = {}) => {
      behavior = next;
      const url = new URL(authorizeUrl);
      const code = NodeCrypto.randomUUID();
      authorizations.set(code, url);
      return `/api/auth/oidc/callback?${new URLSearchParams({ code, state: url.searchParams.get("state")! })}`;
    },
  };
};

const descriptor = {
  environmentId: EnvironmentId.make("box"),
  label: "Box",
  platform: { os: "linux", arch: "x64", machine: "server" },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: false },
} as const;

const makeRoutes = (
  config: OidcSignInSettings | undefined,
  issuer: HttpClient.HttpClient,
  capture: (auth: EnvironmentAuth.EnvironmentAuth["Service"]) => void,
) => {
  const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-oidc-test-" });
  const layerOidcConfig = Layer.succeed(OidcSignInConfig, config);
  const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
    Layer.provide(layerOidcConfig),
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerConfig),
  );
  return Layer.mergeAll(
    Layer.effectDiscard(
      EnvironmentAuth.EnvironmentAuth.pipe(Effect.tap((auth) => Effect.sync(() => capture(auth)))),
    ),
    HttpApiBuilder.layer(OidcTestApi),
  ).pipe(
    Layer.provide(AuthHttp.layer),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provide(
      OidcSignIn.layerHttp.pipe(
        Layer.provide(OidcSignIn.layer),
        Layer.provide(layerOidcConfig),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, issuer)),
        Layer.provide(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getDescriptor: Effect.succeed(descriptor),
          }),
        ),
      ),
    ),
    Layer.provideMerge(layerEnvironmentAuth),
    Layer.provide(layerConfig),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
  );
};

type Handler = (path: string, init?: RequestInit) => Effect.Effect<Response>;

const withServer = <A, E>(
  use: (
    handler: Handler,
    issuer: ReturnType<typeof makeIssuer>,
    auth: EnvironmentAuth.EnvironmentAuth["Service"],
  ) => Effect.Effect<A, E>,
  config: { readonly settings: OidcSignInSettings | undefined } = { settings },
) =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const context = Context.make(SecureRandom.SecureRandom, random);
    const issuer = makeIssuer();
    let auth: EnvironmentAuth.EnvironmentAuth["Service"] | undefined;
    const layer = makeRoutes(config.settings, issuer.client, (service) => {
      auth = service;
    });
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layer, { disableLogger: true })),
      (web) => {
        const handler: Handler = (path, init) =>
          Effect.promise(() => web.handler(new Request(`${SERVER}${path}`, init), context));
        // The first request builds the layer, which captures the auth service.
        return handler("/api/auth/session").pipe(Effect.flatMap(() => use(handler, issuer, auth!)));
      },
      (web) => Effect.promise(() => web.dispose()),
    );
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)));

const startSignIn = (
  handler: Handler,
  returnTo: string,
  options: { readonly prompt?: string; readonly clientState?: string } = {},
) =>
  handler(
    `/api/auth/oidc/start?${new URLSearchParams({
      return_to: returnTo,
      ...(options.prompt ? { prompt: options.prompt } : {}),
      ...(options.clientState ? { client_state: options.clientState } : {}),
    })}`,
  ).pipe(
    Effect.map((response) => {
      const cookie = response.headers.getSetCookie().find((value) => value.startsWith("t3_oidc_"));
      return {
        response,
        location: response.headers.get("location") ?? "",
        cookie,
        /** The `name=value` pair a browser sends back. */
        cookiePair: cookie?.split(";", 1)[0] ?? "",
      };
    }),
  );

/** Signs in through the fake provider and returns where the callback sent the browser. */
const signIn = (
  handler: Handler,
  issuer: ReturnType<typeof makeIssuer>,
  returnTo = `${SERVER}/pair`,
  behavior?: IssuerBehavior,
) =>
  Effect.gen(function* () {
    const started = yield* startSignIn(handler, returnTo);
    const callback = yield* handler(issuer.approve(started.location, behavior), {
      headers: { cookie: started.cookiePair },
    });
    return new URL(callback.headers.get("location") ?? "about:blank");
  });

const hashParam = (url: URL, name: string) =>
  new URLSearchParams(url.hash.slice(1)).get(name) ?? undefined;

const redeemWithBrowserSession = (handler: Handler, credential: string) =>
  handler("/api/auth/browser-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential }),
  }).pipe(Effect.map((response) => response.status));

const redeemWithToken = (handler: Handler, credential: string) =>
  handler("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: AuthTokenExchangeGrantType,
      subject_token: credential,
      subject_token_type: AuthEnvironmentBootstrapTokenType,
      requested_token_type: AuthAccessTokenType,
    }),
  }).pipe(Effect.map((response) => response.status));

it.effect("advertises sign-in and starts it with PKCE, state, nonce and a browser binding", () =>
  withServer((handler) =>
    Effect.gen(function* () {
      const session = yield* handler("/api/auth/session");
      expect(yield* Effect.promise(() => session.json())).toMatchObject({
        auth: { oidc: { label: "Schnau ID", origin: SERVER } },
      });

      const started = yield* startSignIn(handler, `${SERVER}/pair`, { prompt: "none" });
      expect(started.response.status).toBe(302);
      expect(started.response.headers.get("referrer-policy")).toBe("no-referrer");
      const authorize = new URL(started.location);
      expect(`${authorize.origin}${authorize.pathname}`).toBe(`${ISSUER}/auth`);
      expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: `${SERVER}/api/auth/oidc/callback`,
        code_challenge_method: "S256",
        prompt: "none",
      });
      for (const name of ["state", "nonce", "code_challenge"]) {
        expect(authorize.searchParams.get(name)?.length).toBeGreaterThan(40);
      }
      expect(started.cookie).toMatch(/HttpOnly/);
      expect(started.cookie).toMatch(/SameSite=Lax/);
      expect(started.cookie).toMatch(/Path=\/api\/auth\/oidc/);
      expect(started.cookie).toMatch(/Secure/);
    }),
  ),
);

it.effect("stays off without an issuer", () =>
  withServer(
    (handler) =>
      Effect.gen(function* () {
        const session = yield* handler("/api/auth/session");
        expect(yield* Effect.promise(() => session.json())).not.toHaveProperty("auth.oidc");
        expect((yield* startSignIn(handler, `${SERVER}/pair`)).response.status).toBe(404);
      }),
    { settings: undefined },
  ),
);

it.effect.each([
  `https://evil.example.test/pair`,
  `${SERVER}/elsewhere`,
  `${SERVER}/pair?next=/`,
  `https://user@other.example.test/pair`,
  `javascript:alert(1)`,
  `t3code-evil://oidc`,
  "",
])("refuses to return to %j", (returnTo) =>
  withServer((handler) =>
    Effect.gen(function* () {
      const started = yield* startSignIn(handler, returnTo);
      expect(started.response.status).toBe(400);
      expect(started.location).toBe("");
    }),
  ),
);

it.effect.each(["browser-session", "token"] as const)(
  "mints a pairing grant that redeems once, first through %s",
  (first) =>
    withServer((handler, issuer, auth) =>
      Effect.gen(function* () {
        const landed = yield* signIn(handler, issuer);
        expect(`${landed.origin}${landed.pathname}${landed.search}`).toBe(`${SERVER}/pair`);
        const token = hashParam(landed, "token")!;
        expect(yield* auth.listPairingLinks()).toHaveLength(0);

        const [redeem, again] =
          first === "browser-session"
            ? [redeemWithBrowserSession, redeemWithToken]
            : [redeemWithToken, redeemWithBrowserSession];
        expect(yield* redeem(handler, token)).toBe(200);
        expect(yield* again(handler, token)).toBe(401);
        const sessions = yield* auth.listSessions();
        expect(sessions.map((session) => session.subject)).toEqual(["oidc:user-1"]);
      }),
    ),
);

it.effect.each([
  ["another server", "https://other.example.test/pair", "https://other.example.test/pair"],
  ["the app", "t3code://oidc", "t3code://oidc"],
] as const)("hands %s the grant with this server's address", ([_name, returnTo, landing]) =>
  withServer((handler, issuer) =>
    Effect.gen(function* () {
      const landed = yield* signIn(handler, issuer, returnTo);
      expect(landed.toString().startsWith(landing)).toBe(true);
      expect(landed.searchParams.get("host")).toBe(SERVER);
      expect(landed.searchParams.get("label")).toBe("Box");
      expect(hashParam(landed, "token")?.length).toBeGreaterThan(0);
    }),
  ),
);

it.effect("refuses a callback from another browser, an unknown state or a reused one", () =>
  withServer((handler, issuer) =>
    Effect.gen(function* () {
      const started = yield* startSignIn(handler, `${SERVER}/pair`);
      const callback = issuer.approve(started.location);
      const cookieName = started.cookiePair.split("=", 1)[0];
      const elsewhere = yield* handler(callback, { headers: { cookie: `${cookieName}=other` } });
      expect(elsewhere.status).toBe(400);
      expect(elsewhere.headers.get("location")).toBeNull();

      const unknown = yield* handler("/api/auth/oidc/callback?code=x&state=unknown");
      expect(unknown.status).toBe(400);

      // Two sign-ins in one browser keep their own bindings, whichever finishes first.
      const first = yield* startSignIn(handler, `${SERVER}/pair`);
      const second = yield* startSignIn(handler, `${SERVER}/pair`);
      const both = { cookie: `${first.cookiePair}; ${second.cookiePair}` };
      const firstCallback = issuer.approve(first.location);
      const secondCallback = issuer.approve(second.location);
      expect((yield* handler(secondCallback, { headers: both })).status).toBe(302);
      expect((yield* handler(firstCallback, { headers: both })).status).toBe(302);
      expect((yield* handler(firstCallback, { headers: both })).status).toBe(400);
    }),
  ),
);

it.effect("turns new sign-ins away while full, without dropping one in progress", () =>
  withServer((handler, issuer) =>
    Effect.gen(function* () {
      const live = yield* startSignIn(handler, `${SERVER}/pair`);
      for (let index = 1; index < 256; index++) {
        expect((yield* startSignIn(handler, `${SERVER}/pair`)).response.status).toBe(302);
      }
      const turnedAway = yield* startSignIn(handler, `${SERVER}/pair`);
      expect(hashParam(new URL(turnedAway.location), "oidc_error")).toBe("unavailable");
      const callback = yield* handler(issuer.approve(live.location), {
        headers: { cookie: live.cookiePair },
      });
      expect(hashParam(new URL(callback.headers.get("location")!), "token")).toBeDefined();
    }),
  ),
);

it.effect("echoes the app's client state with the result, and refuses a malformed one", () =>
  withServer((handler, issuer) =>
    Effect.gen(function* () {
      const clientState = "attempt-0123456789abcdef";
      const started = yield* startSignIn(handler, "t3code://oidc", { clientState });
      const callback = yield* handler(issuer.approve(started.location), {
        headers: { cookie: started.cookiePair },
      });
      const landed = new URL(callback.headers.get("location")!);
      expect(hashParam(landed, "client_state")).toBe(clientState);
      expect(hashParam(landed, "token")).toBeDefined();
      const malformed = yield* startSignIn(handler, "t3code://oidc", { clientState: "short" });
      expect(malformed.response.status).toBe(400);
    }),
  ),
);

it.effect.each([
  ["a wrong nonce", { nonce: "other" }, "sign_in_failed"],
  ["a wrong audience", { audience: "another-client" }, "sign_in_failed"],
  [
    "a foreign signature",
    { signWith: NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey },
    "sign_in_failed",
  ],
  ["a user outside the required group", { claims: { groups: ["family"] } }, "not_allowed"],
] as const)("refuses an ID token with %s", ([_name, behavior, error]) =>
  withServer((handler, issuer, auth) =>
    Effect.gen(function* () {
      const landed = yield* signIn(handler, issuer, `${SERVER}/pair`, behavior);
      expect(hashParam(landed, "oidc_error")).toBe(error);
      expect(hashParam(landed, "token")).toBeUndefined();
      expect(yield* auth.listSessions()).toHaveLength(0);
    }),
  ),
);

it.effect("returns a silent sign-in's login_required to the client", () =>
  withServer((handler) =>
    Effect.gen(function* () {
      const clientState = "attempt-0123456789abcdef";
      const started = yield* startSignIn(handler, "t3code://oidc", { prompt: "none", clientState });
      const state = new URL(started.location).searchParams.get("state")!;
      const callback = yield* handler(
        `/api/auth/oidc/callback?${new URLSearchParams({ error: "login_required", state })}`,
        { headers: { cookie: started.cookiePair } },
      );
      const landed = new URL(callback.headers.get("location")!);
      expect(landed.searchParams.get("host")).toBe(SERVER);
      expect(hashParam(landed, "oidc_error")).toBe("login_required");
      expect(hashParam(landed, "client_state")).toBe(clientState);
    }),
  ),
);

it.each([
  [{ groups: ["family", "t3-owner"] }, "groups=t3-owner", true],
  [{ groups: ["family"] }, "groups=t3-owner", false],
  [{ groups: "t3-owner" }, "groups=t3-owner", true],
  [{ email_verified: true, groups: ["t3-owner"] }, "email_verified=true,groups=t3-owner", true],
  [{ email_verified: false, groups: ["t3-owner"] }, "email_verified=true,groups=t3-owner", false],
  [{}, "groups=t3-owner", false],
] as const)("claims %j against %s", (claims, rule, expected) => {
  const parsed = parseOidcSignInEnv({
    T3CODE_OIDC_ISSUER: ISSUER,
    T3CODE_OIDC_CLIENT_ID: CLIENT_ID,
    T3CODE_OIDC_CLIENT_SECRET_FILE: "/run/secrets/oidc",
    T3CODE_OIDC_REDIRECT_URI: `${SERVER}/api/auth/oidc/callback`,
    T3CODE_OIDC_REQUIRE: rule,
  });
  expect(satisfiesClaimRules(parsed!.require, claims)).toBe(expected);
});

it("reads return origins and app schemes, and requires a claim rule", () => {
  const env = {
    T3CODE_OIDC_ISSUER: ISSUER,
    T3CODE_OIDC_CLIENT_ID: CLIENT_ID,
    T3CODE_OIDC_CLIENT_SECRET_FILE: "/run/secrets/oidc",
    T3CODE_OIDC_REDIRECT_URI: `${SERVER}/api/auth/oidc/callback`,
    T3CODE_OIDC_RETURN_ORIGINS: "https://other.example.test, t3code://, t3code-dev://",
    T3CODE_OIDC_REQUIRE: "groups=t3-owner",
  };
  const parsed = parseOidcSignInEnv(env);
  expect([...parsed!.returnOrigins]).toEqual([SERVER, "https://other.example.test"]);
  expect([...parsed!.returnSchemes]).toEqual(["t3code:", "t3code-dev:"]);
  expect(parsed!.label).toBe("id.example.test");
  expect(parseOidcSignInEnv({})).toBeUndefined();
  expect(() => parseOidcSignInEnv({ ...env, T3CODE_OIDC_REQUIRE: "" })).toThrow(/at least one/);
  expect(() =>
    parseOidcSignInEnv({ ...env, T3CODE_OIDC_ISSUER: "http://id.example.test" }),
  ).toThrow(/https/);
  expect(
    parseOidcSignInEnv({ ...env, T3CODE_OIDC_ISSUER: "http://127.0.0.1:5556/dex" })?.issuer,
  ).toBe("http://127.0.0.1:5556/dex");
  expect(() =>
    parseOidcSignInEnv({ ...env, T3CODE_OIDC_RETURN_ORIGINS: "https://other.example.test/pair" }),
  ).toThrow(/origin/);
});
