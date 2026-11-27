import { buildOidcSignInUrl, readOidcSignInFailure } from "@t3tools/shared/remote";

/**
 * Whether this page can leave for a provider's page and come back. Every browser, the hosted app
 * included, can; the desktop renderer cannot, and signs in through its bridge's window instead.
 */
export function canSignInWithOidc(): boolean {
  return window.desktopBridge === undefined;
}

/** Whether this client can sign in through a server's provider at all. */
export function offersOidcSignIn(): boolean {
  return canSignInWithOidc() || window.desktopBridge?.signInWithOidc !== undefined;
}

/** Leaves for the sign-in of the server at `origin`; it returns to `returnOrigin`'s pairing page. */
export function startOidcSignIn(origin: string, returnOrigin = window.location.origin): void {
  window.location.assign(
    buildOidcSignInUrl(origin, { returnTo: new URL("/pair", returnOrigin).toString() }),
  );
}

export function peekOidcSignInFailure() {
  return readOidcSignInFailure(new URL(window.location.href));
}

/** A failure another server's sign-in sent back, which the hosted pairing page shows. */
export function hasHostedOidcSignInFailure(url: URL = new URL(window.location.href)): boolean {
  return (readOidcSignInFailure(url)?.host ?? "") !== "";
}
