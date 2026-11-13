import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  buildOidcSignInUrl,
  describeOidcSignInError,
  readHostedPairingRequest,
  readOidcSignInFailure,
  setPairingTokenOnUrl,
} from "@t3tools/shared/remote";
import Constants from "expo-constants";
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
  // A shared session makes iOS ask "wants to use ... to sign in" every time; the fleet's
  // provider signs in without cookies, so the ephemeral sheet stays silent.
  const result = await WebBrowser.openAuthSessionAsync(
    buildOidcSignInUrl(origin, { returnTo, ...options }),
    returnTo,
    { preferEphemeralSession: true },
  );
  if (result.type !== "success") return { _tag: "Cancelled" };
  const url = new URL(result.url);
  const request = readHostedPairingRequest(url);
  // Another app can open this scheme while the sheet is up; only the server signed in to counts.
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
