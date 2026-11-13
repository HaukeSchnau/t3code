import {
  AuthStandardClientScopes,
  EnvironmentHttpApi,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { buildOidcSignInResultUrl } from "@t3tools/shared/remote";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Base64Url from "effect/encoding/Base64Url";
import { HttpClient, HttpClientRequest, HttpServerResponse } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as JoseError from "effect/jose/JoseError";
import * as Jwks from "effect/jose/Jwks";
import * as Jwt from "effect/jose/Jwt";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { renderErrorPage } from "./mcpOAuthHtml.ts";
import {
  isWebUrl,
  OidcSignInConfig,
  type OidcSignInSettings,
  satisfiesClaimRules,
} from "./OidcSignInConfig.ts";

const BINDING_COOKIE = "t3_oidc_binding";
const BINDING_COOKIE_PATH = "/api/auth/oidc";
const PENDING_TTL = Duration.minutes(10);
const MAX_PENDING = 256;
const GRANT_TTL = Duration.minutes(2);
const JWKS_CACHE_TTL = Duration.minutes(10);
const HTTP_TIMEOUT = Duration.seconds(10);
const PROMPTS = new Set(["none", "login", "consent", "select_account"]);
const SCOPE = "openid email groups";
// Codes the provider may send back that a client can act on; anything else reads as a failure.
const FORWARDED_PROVIDER_ERRORS = new Set([
  "login_required",
  "interaction_required",
  "consent_required",
  "account_selection_required",
  "access_denied",
]);

/** What a sign-in route answers: a navigation onward, or a page that ends the sign-in. */
export type OidcSignInStep =
  | {
      readonly _tag: "Redirect";
      readonly location: string;
      /** Set to bind a new sign-in to this browser, or null to clear the binding. */
      readonly binding?: string | null;
    }
  | { readonly _tag: "Page"; readonly status: number; readonly message: string };

interface PendingSignIn {
  readonly binding: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly returnTo: URL;
  readonly expiresAt: number;
}

const Discovery = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  jwks_uri: Schema.String,
});
const TokenResponse = Schema.Struct({ id_token: Schema.NonEmptyString });
const IdTokenClaims = Schema.Record(Schema.String, Schema.Unknown);
const decodeDiscovery = Schema.decodeUnknownEffect(Discovery);
const decodeTokens = Schema.decodeUnknownEffect(TokenResponse);
const decodeKeySet = Schema.decodeUnknownEffect(Jwks.KeySet);

class OidcSignInFailure extends Schema.TaggedError<OidcSignInFailure>()("OidcSignInFailure", {
  code: Schema.String,
  detail: Schema.String,
}) {}

const page = (status: number, message: string): OidcSignInStep => ({
  _tag: "Page",
  status,
  message,
});

// RFC 6749 2.3.1: Basic credentials are form-encoded before base64.
const basicCredentials = (clientId: string, secret: string) =>
  `Basic ${Base64.encode(`${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`)}`;

export class OidcSignIn extends Context.Service<
  OidcSignIn,
  {
    readonly start: (input: {
      readonly returnTo: string | null;
      readonly prompt: string | null;
    }) => Effect.Effect<OidcSignInStep>;
    readonly callback: (input: {
      readonly params: URLSearchParams;
      readonly binding: string | undefined;
    }) => Effect.Effect<OidcSignInStep>;
  }
>()("t3/auth/OidcSignIn") {}

/** @public */
export const make = Effect.gen(function* () {
  const settings = yield* OidcSignInConfig;
  const http = yield* HttpClient.HttpClient;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const signature = yield* Signature.Signature;
  const pending = new Map<string, PendingSignIn>();
  let discovered: typeof Discovery.Type | undefined;
  let keySet: { readonly keys: Jwks.KeySet; readonly expiresAt: number } | undefined;

  const randomToken = (size: number) => random.randomBytes(size).pipe(Effect.map(Base64Url.encode));
  const fail = (code: string, detail: string) => new OidcSignInFailure({ code, detail });

  const getJson = (url: string) =>
    http.get(url, { headers: { accept: "application/json" } }).pipe(
      Effect.filterOrFail((response) => response.status === 200),
      Effect.flatMap((response) => response.json),
      Effect.timeout(HTTP_TIMEOUT),
      Effect.mapError(() => fail("unavailable", `GET ${url} failed.`)),
    );

  // The provider's endpoints must live on the issuer's origin, so a tampered document cannot
  // send the code or the client secret elsewhere.
  const discover = Effect.fn("OidcSignIn.discover")(function* (config: OidcSignInSettings) {
    if (discovered) return discovered;
    const document = yield* getJson(
      `${config.issuer.replace(/\/+$/u, "")}/.well-known/openid-configuration`,
    ).pipe(
      Effect.flatMap(decodeDiscovery),
      Effect.mapError(() => fail("unavailable", "The provider's discovery document is invalid.")),
    );
    const issuerOrigin = new URL(config.issuer).origin;
    const endpoints = [document.authorization_endpoint, document.token_endpoint, document.jwks_uri];
    if (
      document.issuer !== config.issuer ||
      endpoints.some((url) => !URL.canParse(url) || new URL(url).origin !== issuerOrigin)
    ) {
      return yield* fail("unavailable", "The provider's discovery document names another issuer.");
    }
    discovered = document;
    return document;
  });

  const fetchKeySet = Effect.fn("OidcSignIn.fetchKeySet")(function* (jwksUri: string) {
    const keys = yield* getJson(jwksUri).pipe(
      Effect.flatMap(decodeKeySet),
      Effect.mapError(() => fail("unavailable", "The provider's signing keys are invalid.")),
    );
    keySet = {
      keys,
      expiresAt: (yield* Clock.currentTimeMillis) + Duration.toMillis(JWKS_CACHE_TTL),
    };
    return keys;
  });

  const verifyIdToken = Effect.fn("OidcSignIn.verifyIdToken")(function* (
    config: OidcSignInSettings,
    document: typeof Discovery.Type,
    token: string,
  ) {
    const verifyWith = (keys: Jwks.KeySet) =>
      Jwks.makeLocal(keys).pipe(
        Effect.flatMap((jwks) =>
          Jwt.verifyWithKeySet(IdTokenClaims, token, {
            issuer: config.issuer,
            audience: config.clientId,
            algorithms: ["RS256", "ES256"],
            clockTolerance: "30 seconds",
            requiredClaims: ["exp", "sub"],
          }).pipe(Effect.provideService(Jwks.Jwks, jwks)),
        ),
        Effect.provideService(Signature.Signature, signature),
      );
    const fresh = fetchKeySet(document.jwks_uri).pipe(Effect.flatMap(verifyWith));
    const cached = keySet;
    const verified =
      cached === undefined || cached.expiresAt <= (yield* Clock.currentTimeMillis)
        ? fresh
        : verifyWith(cached.keys).pipe(
            // A rotated key is unknown to the cache, so the set is fetched again once.
            Effect.catchIf(
              (error) => JoseError.isJoseError(error) && error.reason._tag === "KeyNotFound",
              () => fresh,
            ),
          );
    return yield* verified.pipe(
      Effect.mapError((error) =>
        error._tag === "OidcSignInFailure"
          ? error
          : fail("sign_in_failed", "The provider's ID token did not verify."),
      ),
    );
  });

  const exchangeCode = Effect.fn("OidcSignIn.exchangeCode")(function* (
    config: OidcSignInSettings,
    document: typeof Discovery.Type,
    code: string,
    verifier: string,
  ) {
    const response = yield* http
      .execute(
        HttpClientRequest.post(document.token_endpoint).pipe(
          HttpClientRequest.setHeaders({
            accept: "application/json",
            authorization: basicCredentials(config.clientId, Redacted.value(config.clientSecret)),
          }),
          HttpClientRequest.bodyText(
            new URLSearchParams({
              grant_type: "authorization_code",
              code,
              redirect_uri: config.redirectUri.toString(),
              code_verifier: verifier,
            }).toString(),
            "application/x-www-form-urlencoded",
          ),
        ),
      )
      .pipe(
        Effect.timeout(HTTP_TIMEOUT),
        Effect.mapError(() => fail("unavailable", "The token endpoint could not be reached.")),
      );
    if (response.status !== 200) {
      return yield* fail("sign_in_failed", `The token endpoint answered ${response.status}.`);
    }
    return yield* response.json.pipe(
      Effect.flatMap(decodeTokens),
      Effect.mapError(() => fail("sign_in_failed", "The token response has no ID token.")),
    );
  });

  const pruneExpired = (now: number) => {
    for (const [state, entry] of pending) if (entry.expiresAt <= now) pending.delete(state);
    // Unauthenticated starts must not grow memory without bound; the oldest give way.
    for (const state of pending.keys()) {
      if (pending.size < MAX_PENDING) break;
      pending.delete(state);
    }
  };

  const resolveReturnTo = (config: OidcSignInSettings, raw: string | null): URL | undefined => {
    if (!raw || !URL.canParse(raw)) return undefined;
    const url = new URL(raw);
    if (url.username || url.password || url.search || url.hash) return undefined;
    if (isWebUrl(url)) {
      return config.returnOrigins.has(url.origin) && url.pathname === "/pair" ? url : undefined;
    }
    return config.returnSchemes.has(url.protocol) ? url : undefined;
  };

  const resultUrl = (
    config: OidcSignInSettings,
    returnTo: URL,
    descriptor: ExecutionEnvironmentDescriptor | undefined,
    result: { readonly token: string } | { readonly error: string },
  ) => {
    const own = config.redirectUri.origin;
    // This server's own page pairs with a cookie; any other client pairs with `host`.
    const toSelf = isWebUrl(returnTo) && returnTo.origin === own;
    return buildOidcSignInResultUrl(returnTo, {
      ...(toSelf ? {} : { host: own, ...(descriptor ? { label: descriptor.label } : {}) }),
      result,
    }).toString();
  };

  const start: OidcSignIn["Service"]["start"] = Effect.fn("OidcSignIn.start")(function* (input) {
    if (settings === undefined) return page(404, "Sign-in is not set up on this server.");
    const returnTo = resolveReturnTo(settings, input.returnTo);
    if (returnTo === undefined) {
      return page(400, "This sign-in link may not return to that address.");
    }
    if (input.prompt !== null && !PROMPTS.has(input.prompt)) {
      return page(400, "This sign-in link asks for an unknown prompt.");
    }
    const descriptor = yield* environment.getDescriptor;
    return yield* Effect.gen(function* () {
      const document = yield* discover(settings);
      const [state, nonce, verifier, binding] = yield* Effect.all([
        randomToken(32),
        randomToken(32),
        randomToken(64),
        randomToken(32),
      ]);
      const challenge = Base64Url.encode(
        yield* digest.digest(Digest.sha256, new TextEncoder().encode(verifier)),
      );
      const now = yield* Clock.currentTimeMillis;
      pruneExpired(now);
      pending.set(state, {
        binding,
        nonce,
        verifier,
        returnTo,
        expiresAt: now + Duration.toMillis(PENDING_TTL),
      });
      const url = new URL(document.authorization_endpoint);
      for (const [name, value] of Object.entries({
        response_type: "code",
        client_id: settings.clientId,
        redirect_uri: settings.redirectUri.toString(),
        scope: SCOPE,
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: "S256",
        ...(input.prompt === null ? {} : { prompt: input.prompt }),
      })) {
        url.searchParams.set(name, value);
      }
      return { _tag: "Redirect", location: url.toString(), binding } satisfies OidcSignInStep;
    }).pipe(
      Effect.catchTags({
        OidcSignInFailure: (error) =>
          Effect.logWarning("OIDC sign-in could not start.", { detail: error.detail }).pipe(
            Effect.as<OidcSignInStep>({
              _tag: "Redirect",
              location: resultUrl(settings, returnTo, descriptor, { error: error.code }),
            }),
          ),
      }),
    );
  });

  const callback: OidcSignIn["Service"]["callback"] = Effect.fn("OidcSignIn.callback")(
    function* (input) {
      if (settings === undefined) return page(404, "Sign-in is not set up on this server.");
      const state = input.params.get("state") ?? "";
      const entry = pending.get(state);
      pending.delete(state);
      const now = yield* Clock.currentTimeMillis;
      if (entry === undefined || entry.expiresAt <= now) {
        return page(400, "This sign-in expired or was already used. Start it again.");
      }
      if (input.binding !== entry.binding) {
        return page(400, "This sign-in was started in another browser. Start it again here.");
      }
      const descriptor = yield* environment.getDescriptor;
      const finish = (result: { readonly token: string } | { readonly error: string }) =>
        ({
          _tag: "Redirect",
          location: resultUrl(settings, entry.returnTo, descriptor, result),
          binding: null,
        }) satisfies OidcSignInStep;

      return yield* Effect.gen(function* () {
        const providerError = input.params.get("error");
        if (providerError !== null) {
          return yield* fail(
            FORWARDED_PROVIDER_ERRORS.has(providerError) ? providerError : "sign_in_failed",
            `The provider answered ${providerError}.`,
          );
        }
        const code = input.params.get("code");
        if (!code) return yield* fail("sign_in_failed", "The provider sent no code.");
        const document = yield* discover(settings);
        // RFC 9207: a provider that names itself must name this one.
        const returnedIssuer = input.params.get("iss");
        if (returnedIssuer !== null && returnedIssuer !== document.issuer) {
          return yield* fail("sign_in_failed", "The callback names another issuer.");
        }
        const tokens = yield* exchangeCode(settings, document, code, entry.verifier);
        const { claims } = yield* verifyIdToken(settings, document, tokens.id_token);
        if (claims.nonce !== entry.nonce) {
          return yield* fail("sign_in_failed", "The ID token's nonce does not match.");
        }
        const subject = claims.sub;
        if (typeof subject !== "string" || subject === "") {
          return yield* fail("sign_in_failed", "The ID token has no subject.");
        }
        if (!satisfiesClaimRules(settings.require, claims)) {
          return yield* fail(
            "not_allowed",
            `Subject ${subject} does not meet T3CODE_OIDC_REQUIRE.`,
          );
        }
        // The grant pairs the browser the way a pairing link does, so sessions, revocation and
        // `t3 auth session list` stay as they are.
        const grant = yield* auth
          .createPairingLink({
            ttl: GRANT_TTL,
            scopes: AuthStandardClientScopes,
            subject: `${EnvironmentAuth.OIDC_SUBJECT_PREFIX}${subject}`,
          })
          .pipe(
            Effect.mapError((error) =>
              error._tag === "ManagedPolicyRefusedError"
                ? fail("pairing_disabled", error.message)
                : fail("sign_in_failed", error.message),
            ),
          );
        yield* Effect.logInfo("OIDC sign-in minted a pairing grant.", {
          subject,
          email: typeof claims.email === "string" ? claims.email : undefined,
        });
        return finish({ token: grant.credential });
      }).pipe(
        Effect.catchTags({
          OidcSignInFailure: (error) =>
            Effect.logWarning("OIDC sign-in failed.", {
              code: error.code,
              detail: error.detail,
            }).pipe(Effect.as(finish({ error: error.code }))),
        }),
      );
    },
  );

  return OidcSignIn.of({ start, callback });
});

export const layer = Layer.effect(OidcSignIn, make);

const NAVIGATION_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};
const PAGE_HEADERS = {
  ...NAVIGATION_HEADERS,
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
};

const render = Effect.fnUntraced(function* (step: OidcSignInStep, secure: boolean) {
  if (step._tag === "Page") {
    return HttpServerResponse.text(
      renderErrorPage(step.message, "Close this page and sign in again from T3 Code."),
      {
        status: step.status,
        contentType: "text/html; charset=utf-8",
        headers: PAGE_HEADERS,
      },
    );
  }
  const response = HttpServerResponse.redirect(step.location, { headers: NAVIGATION_HEADERS });
  const cookie = { httpOnly: true, path: BINDING_COOKIE_PATH, sameSite: "lax", secure } as const;
  if (step.binding === undefined) return response;
  return yield* (
    step.binding === null
      ? HttpServerResponse.expireCookie(response, BINDING_COOKIE, cookie)
      : HttpServerResponse.setCookie(response, BINDING_COOKIE, step.binding, {
          ...cookie,
          maxAge: PENDING_TTL,
        })
  ).pipe(Effect.orDie);
});

export const layerHttp = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "oidc",
  Effect.fnUntraced(function* (handlers) {
    const signIn = yield* OidcSignIn;
    const settings = yield* OidcSignInConfig;
    const secure = settings?.redirectUri.protocol === "https:";
    const query = (url: string) => new URL(url, "http://localhost").searchParams;
    return handlers
      .handleRaw("start", ({ request }) => {
        const params = query(request.url);
        return signIn
          .start({ returnTo: params.get("return_to"), prompt: params.get("prompt") })
          .pipe(Effect.flatMap((step) => render(step, secure)));
      })
      .handleRaw("callback", ({ request }) =>
        signIn
          .callback({ params: query(request.url), binding: request.cookies[BINDING_COOKIE] })
          .pipe(Effect.flatMap((step) => render(step, secure))),
      );
  }),
);
