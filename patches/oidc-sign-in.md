# OIDC sign-in

## Purpose

Every device pairs with every fleet server through a one-time code, once per server. The fleet
has its own OpenID Connect issuer, so a server can let a device in once the issuer vouches for its
user. Upstream closed OIDC as not planned (pingdotgg/t3code#12278).

## Behavior

- `apps/server/src/auth/OidcSignInConfig.ts` reads `T3CODE_OIDC_*` from the environment. Without
  `T3CODE_OIDC_ISSUER` nothing changes. A broken setup is logged and leaves sign-in off rather
  than stopping the server. `T3CODE_OIDC_REQUIRE` is mandatory, because a provider can sign in
  people this server must not trust. The issuer must use https unless it is on loopback. The
  server asks for the `openid email groups` scopes, which Dex accepts. A provider that rejects
  unknown scopes, such as Google, has to sit behind Dex.
- `apps/server/src/auth/OidcSignIn.ts` is a confidential relying party with PKCE S256, state and
  nonce. `GET /api/auth/oidc/start` accepts a `return_to` that is a `/pair` page on an allowed web
  origin or an allowed app scheme, and passes `prompt` through. It binds each sign-in to the
  starting browser with its own httpOnly SameSite=Lax cookie scoped to `/api/auth/oidc`. State,
  nonce and verifier stay in memory for 10 minutes and are spent once; at most 256 sign-ins are
  pending, and a start beyond that returns to `return_to` with `oidc_error=unavailable` instead of
  pushing one out. An optional `client_state` comes back in the result's fragment.
- `GET /api/auth/oidc/callback` checks the binding, exchanges the code, verifies the ID token
  (RS256/ES256, issuer, audience, nonce, a 10-minute JWKS cache that refetches for an unknown
  `kid`) and the claim rules. It does not issue a session. It mints a 2-minute pairing grant with
  subject `oidc:<sub>` and no label, the step `cloud/CloudLink.ts` takes for T3 Connect, and
  redirects to `/pair#token=<code>` on its own origin. Another origin or an app scheme gets
  `?host=<this server>&label=<label>#token=<code>`, which every client already redeems as a
  hosted pairing link. Failures return the same way with `#oidc_error=<code>`. Sessions, revocation
  and `t3 auth session list` stay as they are.
- `listPairingLinks` hides `oidc:` grants, and a managed policy without remote clients revokes
  `oidc:` sessions and grants with the other link-paired ones.
- `ServerAuthDescriptor.oidc` advertises sign-in with its label and `origin`, the redirect URI's
  origin. The provider returns only there and the browser binding lives there, so every client
  starts the sign-in at `origin`, whatever address it reached the server by. Web shows a button
  on the pairing page and in **Add environment** (after reading the typed host's
  `/api/auth/session`), and shows `#oidc_error`. The desktop renderer cannot leave for the
  provider and come back, so it keeps pairing with codes. Mobile signs in when Connect has no
  code and is not adding a route to a known machine, through an ephemeral `openAuthSessionAsync`
  sheet that returns to `<scheme>://oidc`. It accepts only a result that carries back the random
  `client_state` it sent, since another app can open that scheme. The grant itself is not bound
  to the device; binding it (DPoP) would make every request of the session carry a proof. A
  shared sheet makes iOS ask for permission on every sign-in. The ephemeral sheet has no cookies,
  so it is silent only when the provider recognizes the device without one, as the fleet's
  Tailnet upstream does.

## Upstream touch points

- `packages/contracts/src/auth.ts` (`ServerAuthDescriptor.oidc`) and
  `packages/contracts/src/environmentHttp.ts` (the `oidc` group).
- `apps/server/src/auth/EnvironmentAuth.ts`: `listPairingLinks` and
  `revokePairedClientsThePolicyDisallows`. `apps/server/src/auth/EnvironmentAuthPolicy.ts` reads
  the config reference. `apps/server/src/server.ts` wires the layers.
- `packages/client-runtime/src/authorization/remote.ts`: `fetchRemoteSessionState` takes an
  optional bearer token.
- Web: `PairingRouteSurface.tsx`, `AddEnvironmentDialog.tsx`, `routes/__root.tsx`,
  `routes/pair.tsx`. Mobile: `ConnectionsNewRouteScreen.tsx`.

## Removal

Drop this if upstream ships provider sign-in that hands out the same pairing grants.

## Verification

`apps/server/src/auth/OidcSignIn.test.ts` runs the routes against an in-process issuer that signs
RS256 tokens: start parameters and the cookie, refused return URLs, single-use redemption through
`/api/auth/browser-session` and `/oauth/token`, hosted results, binding and state reuse, wrong
nonce, audience and signature, claim rules, and `login_required`. `EnvironmentAuthAdmin.test.ts`
covers hiding and revoking `oidc:` grants.
