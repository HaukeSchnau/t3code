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

// One cookie per sign-in, so sign-ins started in two tabs do not overwrite each other's binding.
const BINDING_COOKIE_PREFIX = "t3_oidc_";
const BINDING_COOKIE_PATH = "/api/auth/oidc";
const PENDING_TTL = Duration.minutes(10);
const MAX_PENDING = 256;
const GRANT_TTL = Duration.minutes(2);
const JWKS_CACHE_TTL = Duration.minutes(10);
const HTTP_TIMEOUT = Duration.seconds(10);
const PROMPTS = new Set(["none", "login", "consent", "select_account"]);
const SCOPE = "openid email groups";
// An app's return URL carries this back, so the app can tell its own sign-in's result apart.
const CLIENT_STATE = /^[A-Za-z0-9_-]{16,128}$/u;
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
      /** Binds a new sign-in to this browser, or clears a finished one's binding (null value). */
      readonly binding?: { readonly cookie: string; readonly value: string | null };
    }
  | { readonly _tag: "Page"; readonly status: number; readonly message: string };

interface PendingSignIn {
  readonly cookie: string;
  readonly binding: string;
  readonly clientState: string | null;
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

/** `stage` names the step that failed for logs; provider data and identities stay out of them. */
class OidcSignInFailure extends Schema.TaggedError<OidcSignInFailure>()("OidcSignInFailure", {
  code: Schema.String,
  stage: Schema.String,
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
      readonly clientState: string | null;
    }) => Effect.Effect<OidcSignInStep>;
    readonly callback: (input: {
      readonly params: URLSearchParams;
      readonly cookies: Readonly<Record<string, string | undefined>>;
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
  const fail = (code: string, stage: string) => new OidcSignInFailure({ code, stage });

  const getJson = (url: string, stage: string) =>
    http.get(url, { headers: { accept: "application/json" } }).pipe(
      Effect.filterOrFail((response) => response.status === 200),
      Effect.flatMap((response) => response.json),
      Effect.timeout(HTTP_TIMEOUT),
      Effect.mapError(() => fail("unavailable", stage)),
    );

  // The provider's endpoints must live on the issuer's origin, so a tampered document cannot
  // send the code or the client secret elsewhere.
  const discover = Effect.fn("OidcSignIn.discover")(function* (config: OidcSignInSettings) {
    if (discovered) return discovered;
    const document = yield* getJson(
      `${config.issuer.replace(/\/+$/u, "")}/.well-known/openid-configuration`,
      "discovery",
    ).pipe(
      Effect.flatMap(decodeDiscovery),
      Effect.mapError(() => fail("unavailable", "discovery")),
    );
    const issuerOrigin = new URL(config.issuer).origin;
    const endpoints = [document.authorization_endpoint, document.token_endpoint, document.jwks_uri];
    if (
      document.issuer !== config.issuer ||
      endpoints.some((url) => !URL.canParse(url) || new URL(url).origin !== issuerOrigin)
    ) {
      return yield* fail("unavailable", "discovery-issuer");
    }
    discovered = document;
    return document;
  });

  const fetchKeySet = Effect.fn("OidcSignIn.fetchKeySet")(function* (jwksUri: string) {
    const keys = yield* getJson(jwksUri, "keys").pipe(
      Effect.flatMap(decodeKeySet),
      Effect.mapError(() => fail("unavailable", "keys")),
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
        error._tag === "OidcSignInFailure" ? error : fail("sign_in_failed", "id-token"),
      ),
    );
  });

  const exchangeCode = Effect.fn("OidcSignIn.exchangeCode")(function* (
    config: OidcSignInSettings,
    document: typeof Discovery.Type,
    code: string,
    verifier: string,
  ) {
    // The timeout covers the body too: a provider that stalls after its headers fails the sign-in.
    return yield* http
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
        Effect.mapError(() => fail("unavailable", "token")),
        Effect.flatMap((response) =>
          response.status === 200
            ? response.json.pipe(
                Effect.flatMap(decodeTokens),
                Effect.mapError(() => fail("sign_in_failed", "token-response")),
              )
            : Effect.fail(fail("sign_in_failed", "token-status")),
        ),
        Effect.timeoutOrElse({
          duration: HTTP_TIMEOUT,
          orElse: () => Effect.fail(fail("unavailable", "token")),
        }),
      );
  });

  const pruneExpired = (now: number) => {
    for (const [state, entry] of pending) if (entry.expiresAt <= now) pending.delete(state);
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
    clientState: string | null,
    result: { readonly token: string } | { readonly error: string },
  ) => {
    const own = config.redirectUri.origin;
    // This server's own page pairs with a cookie; any other client pairs with `host`.
    const toSelf = isWebUrl(returnTo) && returnTo.origin === own;
    return buildOidcSignInResultUrl(returnTo, {
      ...(toSelf ? {} : { host: own, ...(descriptor ? { label: descriptor.label } : {}) }),
      ...(clientState === null ? {} : { clientState }),
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
    if (input.clientState !== null && !CLIENT_STATE.test(input.clientState)) {
      return page(400, "This sign-in link carries an invalid client state.");
    }
    const descriptor = yield* environment.getDescriptor;
    return yield* Effect.gen(function* () {
      const document = yield* discover(settings);
      const now = yield* Clock.currentTimeMillis;
      pruneExpired(now);
      // Unauthenticated starts must not grow memory without bound, nor push out live sign-ins.
      // A full map sends the client back, so a fan-out moves on instead of stopping on a page.
      if (pending.size >= MAX_PENDING) return yield* fail("unavailable", "capacity");
      const [state, nonce, verifier, binding, cookieId] = yield* Effect.all([
        randomToken(32),
        randomToken(32),
        randomToken(64),
        randomToken(32),
        randomToken(12),
      ]);
      const challenge = Base64Url.encode(
        yield* digest.digest(Digest.sha256, new TextEncoder().encode(verifier)),
      );
      const cookie = `${BINDING_COOKIE_PREFIX}${cookieId}`;
      pending.set(state, {
        cookie,
        binding,
        clientState: input.clientState,
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
      return {
        _tag: "Redirect",
        location: url.toString(),
        binding: { cookie, value: binding },
      } satisfies OidcSignInStep;
    }).pipe(
      Effect.catchTags({
        OidcSignInFailure: (error) =>
          Effect.logWarning("OIDC sign-in could not start.", { stage: error.stage }).pipe(
            Effect.as<OidcSignInStep>({
              _tag: "Redirect",
              location: resultUrl(settings, returnTo, descriptor, input.clientState, {
                error: error.code,
              }),
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
      if (input.cookies[entry.cookie] !== entry.binding) {
        return page(400, "This sign-in was started in another browser. Start it again here.");
      }
      const descriptor = yield* environment.getDescriptor;
      const finish = (result: { readonly token: string } | { readonly error: string }) =>
        ({
          _tag: "Redirect",
          location: resultUrl(settings, entry.returnTo, descriptor, entry.clientState, result),
          binding: { cookie: entry.cookie, value: null },
        }) satisfies OidcSignInStep;

      return yield* Effect.gen(function* () {
        const providerError = input.params.get("error");
        if (providerError !== null) {
          return yield* fail(
            FORWARDED_PROVIDER_ERRORS.has(providerError) ? providerError : "sign_in_failed",
            "provider",
          );
        }
        const code = input.params.get("code");
        if (!code) return yield* fail("sign_in_failed", "callback-code");
        const document = yield* discover(settings);
        // RFC 9207: a provider that names itself must name this one.
        const returnedIssuer = input.params.get("iss");
        if (returnedIssuer !== null && returnedIssuer !== document.issuer) {
          return yield* fail("sign_in_failed", "callback-issuer");
        }
        const tokens = yield* exchangeCode(settings, document, code, entry.verifier);
        const { claims } = yield* verifyIdToken(settings, document, tokens.id_token);
        if (claims.nonce !== entry.nonce) {
          return yield* fail("sign_in_failed", "id-token-nonce");
        }
        const subject = claims.sub;
        if (typeof subject !== "string" || subject === "") {
          return yield* fail("sign_in_failed", "id-token-subject");
        }
        if (!satisfiesClaimRules(settings.require, claims)) {
          return yield* fail("not_allowed", "claim-rules");
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
                ? fail("pairing_disabled", "grant-policy")
                : fail("sign_in_failed", "grant"),
            ),
          );
        yield* Effect.logInfo("OIDC sign-in minted a pairing grant.");
        return finish({ token: grant.credential });
      }).pipe(
        Effect.catchTags({
          OidcSignInFailure: (error) =>
            Effect.logWarning("OIDC sign-in failed.", {
              code: error.code,
              stage: error.stage,
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
  if (step.binding === undefined) return response;
  const options = { httpOnly: true, path: BINDING_COOKIE_PATH, sameSite: "lax", secure } as const;
  return yield* (
    step.binding.value === null
      ? HttpServerResponse.expireCookie(response, step.binding.cookie, options)
      : HttpServerResponse.setCookie(response, step.binding.cookie, step.binding.value, {
          ...options,
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
          .start({
            returnTo: params.get("return_to"),
            prompt: params.get("prompt"),
            clientState: params.get("client_state"),
          })
          .pipe(Effect.flatMap((step) => render(step, secure)));
      })
      .handleRaw("callback", ({ request }) =>
        signIn
          .callback({ params: query(request.url), cookies: request.cookies })
          .pipe(Effect.flatMap((step) => render(step, secure))),
      );
  }),
);
