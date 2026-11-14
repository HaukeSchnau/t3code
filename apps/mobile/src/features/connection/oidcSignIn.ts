import type { PeerFanOut } from "@t3tools/client-runtime/connection";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PeerLinkSummary } from "@t3tools/contracts";
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
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";

import { readOidcSignInOffer, resolvePeerSignIn, runPeerFanOut } from "../../connection/onboarding";
import { whenProtectedDataAvailable } from "../../lib/protectedData";
import { appAtomRegistry } from "../../state/atom-registry";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { pairEnvironment, type PairingOutcome } from "../../state/use-remote-environment-registry";

function appScheme(): string {
  const scheme = Constants.expoConfig?.scheme;
  return (Array.isArray(scheme) ? scheme[0] : scheme) ?? "t3code";
}

/** The error of a sheet that could not open, which says nothing about the server. */
export const OIDC_BROWSER_UNAVAILABLE = "browser_unavailable";

// Both platforms show one auth sheet at a time and reject a second, so a sign-in started while
// another sheet is up (the fan-out during a manual add, say) waits for it instead of failing.
let sheetTurn: Promise<unknown> = Promise.resolve();

/** Signs in to the server at `origin` in a browser sheet and returns its pairing code. */
export function signInWithOidc(
  origin: string,
  options?: { readonly prompt?: "none" },
): Promise<PeerFanOut.PeerSignInResult> {
  const turn = sheetTurn.then(() => openSignInSheet(origin, options));
  sheetTurn = turn.catch(() => undefined);
  return turn;
}

async function openSignInSheet(
  origin: string,
  options?: { readonly prompt?: "none" },
): Promise<PeerFanOut.PeerSignInResult> {
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
    return { _tag: "Signed", pairingCode: request.token };
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
  const { origin } = offer.value.value;
  const signedIn = await signInWithOidc(origin);
  if (signedIn._tag === "Cancelled") return { ok: false, error: null };
  if (signedIn._tag === "Failed") {
    return { ok: false, error: describeOidcSignInError(signedIn.error) };
  }
  return pairEnvironment(setPairingTokenOnUrl(new URL(origin), signedIn.pairingCode).toString());
}

/** Adds an environment another one links to, at an address that offers sign-in and is it. */
export async function addLinkedEnvironment(link: PeerLinkSummary): Promise<PairingOutcome> {
  const resolved = await runAtomCommand(appAtomRegistry, resolvePeerSignIn, link, {
    reportFailure: false,
  });
  if (!AsyncResult.isSuccess(resolved) || Option.isNone(resolved.value)) {
    return { ok: false, error: `${link.label} does not offer sign-in here. Pair it with a code.` };
  }
  const { origin } = resolved.value.value;
  const signedIn = await signInWithOidc(origin);
  if (signedIn._tag === "Cancelled") return { ok: false, error: null };
  if (signedIn._tag === "Failed") {
    return { ok: false, error: describeOidcSignInError(signedIn.error) };
  }
  return pairEnvironment(
    setPairingTokenOnUrl(new URL(origin), signedIn.pairingCode).toString(),
    link.environmentId,
  );
}

const triedKey = "t3code.peer-fan-out-tried.v1";
// A phone the provider does not recognize silently tries again the next day, not on every launch.
const RETRY_MS = 24 * 60 * 60 * 1000;

async function readTried(): Promise<Record<string, number>> {
  try {
    await whenProtectedDataAvailable();
    const raw = await SecureStore.getItemAsync(triedKey);
    const value: unknown = raw === null ? {} : JSON.parse(raw);
    return typeof value === "object" && value !== null ? (value as Record<string, number>) : {};
  } catch {
    return {};
  }
}

async function recordAttempt(environmentId: EnvironmentId): Promise<void> {
  const tried = { ...(await readTried()), [environmentId]: Date.now() };
  await SecureStore.setItemAsync(triedKey, JSON.stringify(tried)).catch(() => {});
}

/**
 * Adds the environments the connected ones link to, signing in to each in a silent sheet,
 * whenever another environment connects. App-lifetime; one run at a time.
 */
export function installPeerFanOut(): () => void {
  let running = false;
  let disposed = false;
  let lastRun = "";

  const run = async () => {
    const connected = appAtomRegistry.get(connectedEnvironmentIdsAtom);
    const key = connected.join(",");
    // After everything disconnects, the same set reconnecting is a new chance to run.
    if (connected.length === 0) lastRun = "";
    if (disposed || running || connected.length === 0 || key === lastRun) return;
    running = true;
    lastRun = key;
    try {
      const tried = await readTried();
      const now = Date.now();
      await runAtomCommand(
        appAtomRegistry,
        runPeerFanOut,
        {
          connected,
          skip: new Set(
            Object.entries(tried)
              .filter(([, triedAt]) => now - triedAt < RETRY_MS)
              .map(([environmentId]) => environmentId as EnvironmentId),
          ),
          // Without a browser no sheet can open, so the run ends instead of using up peers.
          signIn: (peer) =>
            Effect.promise(() =>
              signInWithOidc(peer.origin, { prompt: "none" }).then(
                (result): PeerFanOut.PeerSignInResult =>
                  result._tag === "Failed" && result.error === OIDC_BROWSER_UNAVAILABLE
                    ? { _tag: "Cancelled" }
                    : result,
              ),
            ),
          recordAttempt: (peer) => Effect.promise(() => recordAttempt(peer.environmentId)),
        },
        { reportFailure: false },
      );
    } finally {
      running = false;
    }
    // Environments that connected during the run, the added ones among them, get their turn.
    void run();
  };

  const unsubscribe = appAtomRegistry.subscribe(connectedEnvironmentIdsAtom, () => void run(), {
    immediate: true,
  });
  return () => {
    disposed = true;
    unsubscribe();
  };
}
