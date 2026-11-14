import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const OIDC_CALLBACK_PATH = "/api/auth/oidc/callback";

export class OidcSignInConfigError extends Schema.TaggedError<OidcSignInConfigError>()(
  "OidcSignInConfigError",
  { message: Schema.String },
) {}

export interface ClaimRule {
  readonly claim: string;
  readonly value: string;
}

export interface OidcSignInSettings {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
  /** This server's callback; its origin is the address other clients pair with. */
  readonly redirectUri: URL;
  readonly label: string;
  readonly returnOrigins: ReadonlySet<string>;
  /** App schemes as URL protocols, such as `t3code:`. */
  readonly returnSchemes: ReadonlySet<string>;
  readonly require: ReadonlyArray<ClaimRule>;
}

/** Unset means sign-in is off: no route answers and the auth descriptor does not offer it. */
export class OidcSignInConfig extends Context.Reference<OidcSignInSettings | undefined>(
  "t3/auth/OidcSignInConfig",
  { defaultValue: () => undefined },
) {}

const configError = (message: string) => new OidcSignInConfigError({ message });
const isOidcSignInConfigError = Schema.is(OidcSignInConfigError);

export const isWebUrl = (url: URL) => url.protocol === "https:" || url.protocol === "http:";

const parseWebUrl = (name: string, value: string) => {
  if (!URL.canParse(value)) throw configError(`${name} is not a URL.`);
  const url = new URL(value);
  if (!isWebUrl(url)) throw configError(`${name} must be an http or https URL.`);
  return url;
};

const parseReturnTargets = (value: string | undefined, ownOrigin: string) => {
  const origins = new Set([ownOrigin]);
  const schemes = new Set<string>();
  for (const entry of (value ?? "").split(",").map((item) => item.trim())) {
    if (entry === "") continue;
    const scheme = /^([a-z][a-z0-9+.-]*):\/\/$/u.exec(entry);
    if (scheme && scheme[1] !== "http" && scheme[1] !== "https") {
      schemes.add(`${scheme[1]}:`);
      continue;
    }
    const url = parseWebUrl("T3CODE_OIDC_RETURN_ORIGINS", entry);
    if (url.pathname !== "/" || url.search || url.hash) {
      throw configError(`T3CODE_OIDC_RETURN_ORIGINS entry ${entry} must be an origin.`);
    }
    origins.add(url.origin);
  }
  return { origins, schemes };
};

/** Parses `claim=value` rules separated by commas; every rule must hold. */
const parseClaimRules = (value: string | undefined): ReadonlyArray<ClaimRule> => {
  const rules = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map((item) => {
      const separator = item.indexOf("=");
      const claim = item.slice(0, separator).trim();
      const expected = item.slice(separator + 1).trim();
      if (separator <= 0 || claim === "" || expected === "") {
        throw configError(`T3CODE_OIDC_REQUIRE rule ${item} must read claim=value.`);
      }
      return { claim, value: expected };
    });
  // A provider can sign in people this server must not trust, so an empty rule set is refused.
  if (rules.length === 0) throw configError("T3CODE_OIDC_REQUIRE must name at least one rule.");
  return rules;
};

const claimMatches = (claim: unknown, expected: string): boolean => {
  if (Array.isArray(claim)) return claim.some((item) => claimMatches(item, expected));
  return (
    (typeof claim === "string" || typeof claim === "number" || typeof claim === "boolean") &&
    String(claim) === expected
  );
};

/** An array claim must contain the value; any other claim must equal it. */
export const satisfiesClaimRules = (
  rules: ReadonlyArray<ClaimRule>,
  claims: Readonly<Record<string, unknown>>,
): boolean => rules.every((rule) => claimMatches(claims[rule.claim], rule.value));

/** Reads the sign-in settings without the client secret, or undefined when no issuer is set. */
export const parseOidcSignInEnv = (env: Readonly<Record<string, string | undefined>>) => {
  const read = (name: string) => env[name]?.trim() || undefined;
  const issuer = read("T3CODE_OIDC_ISSUER");
  if (issuer === undefined) return undefined;
  const clientId = read("T3CODE_OIDC_CLIENT_ID");
  const clientSecretFile = read("T3CODE_OIDC_CLIENT_SECRET_FILE");
  const redirect = read("T3CODE_OIDC_REDIRECT_URI");
  if (!clientId || !clientSecretFile || !redirect) {
    throw configError(
      "T3CODE_OIDC_ISSUER needs T3CODE_OIDC_CLIENT_ID, T3CODE_OIDC_CLIENT_SECRET_FILE and T3CODE_OIDC_REDIRECT_URI.",
    );
  }
  const issuerUrl = parseWebUrl("T3CODE_OIDC_ISSUER", issuer);
  // The client secret and the signing keys travel to the issuer, so only loopback may use http.
  if (issuerUrl.protocol !== "https:" && !isLocalLoopbackHost(issuerUrl.hostname)) {
    throw configError("T3CODE_OIDC_ISSUER must use https unless it is on this machine.");
  }
  const redirectUri = parseWebUrl("T3CODE_OIDC_REDIRECT_URI", redirect);
  if (redirectUri.pathname !== OIDC_CALLBACK_PATH || redirectUri.search || redirectUri.hash) {
    throw configError(`T3CODE_OIDC_REDIRECT_URI must end in ${OIDC_CALLBACK_PATH}.`);
  }
  const targets = parseReturnTargets(read("T3CODE_OIDC_RETURN_ORIGINS"), redirectUri.origin);
  return {
    issuer,
    clientId,
    clientSecretFile,
    redirectUri,
    label: read("T3CODE_OIDC_LABEL") ?? issuerUrl.host,
    returnOrigins: targets.origins,
    returnSchemes: targets.schemes,
    require: parseClaimRules(read("T3CODE_OIDC_REQUIRE")),
  };
};

/** Reads the settings from the environment; a broken setup is logged and leaves sign-in off. */
export const layerConfig = Layer.effect(
  OidcSignInConfig,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const parsed = yield* Effect.try({
      try: () => parseOidcSignInEnv(process.env),
      catch: (cause) => (isOidcSignInConfigError(cause) ? cause : configError(String(cause))),
    });
    if (parsed === undefined) return undefined;
    const secret = (yield* fileSystem
      .readFileString(parsed.clientSecretFile)
      .pipe(
        Effect.mapError(() =>
          configError(`Could not read T3CODE_OIDC_CLIENT_SECRET_FILE ${parsed.clientSecretFile}.`),
        ),
      )).trim();
    if (secret === "") return yield* configError("T3CODE_OIDC_CLIENT_SECRET_FILE is empty.");
    const { clientSecretFile: _file, ...settings } = parsed;
    yield* Effect.logInfo("OIDC sign-in is on.", {
      issuer: settings.issuer,
      redirectUri: settings.redirectUri.toString(),
    });
    return { ...settings, clientSecret: Redacted.make(secret) } satisfies OidcSignInSettings;
  }).pipe(
    Effect.catchTags({
      OidcSignInConfigError: (error) =>
        Effect.logError("OIDC sign-in is off because its configuration is invalid.", {
          reason: error.message,
        }).pipe(Effect.as(undefined)),
    }),
  ),
);
