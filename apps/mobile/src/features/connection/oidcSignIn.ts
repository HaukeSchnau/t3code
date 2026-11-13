import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  buildOidcSignInUrl,
  describeOidcSignInError,
  readHostedPairingRequest,
  readOidcSignInClientState,
  readOidcSignInFailure,
  setPairingTokenOnUrl,
} from "@t3tools/shared/remote";
import Constants from "expo-constants";
import * as ExpoCrypto from "expo-crypto";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import * as WebBrowser from "expo-web-browser";

import { readOidcSignInOffer } from "../../connection/onboarding";
import { appAtomRegistry } from "../../state/atom-registry";
import { pairEnvironment, type PairingOutcome } from "../../state/use-remote-environment-registry";

function appScheme(): string {
  const scheme = Constants.expoConfig?.scheme;
  return (Array.isArray(scheme) ? scheme[0] : scheme) ?? "t3code";
}

/** The error of a sheet that could not open, which says nothing about the server. */
export const OIDC_BROWSER_UNAVAILABLE = "browser_unavailable";

export type OidcSignInResult =
  | { readonly _tag: "Signed"; readonly pairingUrl: string }
  | { readonly _tag: "Failed"; readonly error: string }
  | { readonly _tag: "Cancelled" };

/** Signs in to the server at `origin` in a browser sheet and returns its pairing link. */
export async function signInWithOidc(
  origin: string,
  options?: { readonly prompt?: "none" },
): Promise<OidcSignInResult> {
  const returnTo = `${appScheme()}://oidc`;
  // Another app can open this scheme while the sheet is up, so only a result that brings this
  // attempt's value back from the server counts.
  const clientState = Base64Url.encode(ExpoCrypto.getRandomBytes(24));
  // A shared session makes iOS ask "wants to use ... to sign in" every time; the fleet's
  // provider signs in without cookies, so the ephemeral sheet stays silent.
  const result = await WebBrowser.openAuthSessionAsync(
    buildOidcSignInUrl(origin, { returnTo, clientState, ...options }),
    returnTo,
    { preferEphemeralSession: true },
  ).catch(() => null);
  // Android rejects when no browser can show the sheet.
  if (result === null) return { _tag: "Failed", error: OIDC_BROWSER_UNAVAILABLE };
  if (result.type !== "success") return { _tag: "Cancelled" };
  const url = new URL(result.url);
  if (readOidcSignInClientState(url) !== clientState) {
    return { _tag: "Failed", error: "sign_in_failed" };
  }
  const request = readHostedPairingRequest(url);
  if (request && URL.canParse(request.host) && new URL(request.host).origin === origin) {
    return {
      _tag: "Signed",
      pairingUrl: setPairingTokenOnUrl(new URL(request.host), request.token).toString(),
    };
  }
  return { _tag: "Failed", error: readOidcSignInFailure(url)?.error ?? "sign_in_failed" };
}

/**
 * Pairs through the server's sign-in when it offers one. Null means it offers none, so the
 * caller pairs with a code instead.
 */
export async function pairWithOidcSignIn(host: string): Promise<PairingOutcome | null> {
  const offer = await runAtomCommand(appAtomRegistry, readOidcSignInOffer, host.trim(), {
    reportFailure: false,
  });
  if (!AsyncResult.isSuccess(offer) || Option.isNone(offer.value)) return null;
  const signedIn = await signInWithOidc(offer.value.value.origin);
  if (signedIn._tag === "Cancelled") return { ok: false, error: null };
  if (signedIn._tag === "Failed") {
    return { ok: false, error: describeOidcSignInError(signedIn.error) };
  }
  return pairEnvironment(signedIn.pairingUrl);
}
