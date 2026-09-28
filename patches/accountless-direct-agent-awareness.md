# Accountless direct agent awareness

## Fork requirement

This single-user fork must not require a T3 Connect or Clerk account. Web, desktop, and mobile
clients connect only to explicitly paired T3 Code environments. Environment pairing remains the
authorization boundary and is intentionally not removed.

## Implementation

- Remove account sign-in, account settings, cloud discovery, and cloud-link screens from the mobile
  client. The mobile theme generator omits the unused Clerk native theme JSON.
- Web keeps upstream's T3 Connect code in the tree and switched off. Fork builds set no Clerk or
  relay config, so `hasCloudPublicConfig()` is false: `main.tsx` never loads a Clerk shell, Settings
  and the welcome wizard show no T3 Connect sign-in or cloud environments, `/connect` redirects
  home, and the managed relay client gets the disabled `relay.invalid` URL.
- `routes/__root.tsx` lazy-loads `ConnectOnboardingDialog` only when `hasCloudPublicConfig()` is
  true. Upstream imports it statically, which puts `@clerk/react` in the startup graph of every
  build. Fork builds never use it, and the lazy import removes 154 KB (41 KB gzip) of startup
  JavaScript. Clerk code still loads, without effect, when Settings, `/welcome`, or `/connect`
  opens.
- Fork builds must never set `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_JWT_TEMPLATE`,
  `VITE_T3CODE_RELAY_URL`, or the `T3CODE_CLERK_*` and `T3CODE_RELAY_URL` values that
  `scripts/lib/public-config.ts` maps onto them. Together they turn account sign-in on.
- Desktop keeps upstream's Clerk bridge. It holds Electron's single-instance lock and routes
  deeplinks from a second launch, and it stays inert without a publishable key: the renderer never
  mounts Clerk. Signed macOS builds skip the passkey entitlements that only account sign-in needs.
- Pairing links in Connections settings always open the backend's own `/pair` page. The fork ships
  no hosted web app, and an `app.t3.codes` link would load upstream's client against this server.
- Mobile keeps the upstream managed-relay interfaces behind a fail-closed compatibility layer so
  shared connection runtime types do not need a fork-wide rewrite. No account credential is read or
  sent.
- Drop legacy relay-managed mobile connections during migration; users pair those environments
  directly instead.
- Register an iOS device and its Live Activity update token over the authenticated environment RPC.
  The first reachable saved direct environment owns the device registration. Removing a saved
  environment first asks it to forget the device, so it stops pushing to the phone. That request is
  best effort and bounded to five seconds, so an unreachable server cannot block removal.
- Persist device registrations in the paired server's secret store and publish that server's local
  aggregate directly to APNs. Cross-environment aggregation is intentionally unsupported: each
  server knows only its own threads, and the first reachable server is authoritative for the card.

## APNs server configuration

Configure every server that may own the iPhone registration with:

```text
T3CODE_APNS_TEAM_ID=<10-character Apple team ID>
T3CODE_APNS_KEY_ID=<APNs provider key ID>
T3CODE_APNS_PRIVATE_KEY_FILE=/absolute/path/to/AuthKey_<key-id>.p8
```

`T3CODE_APNS_PRIVATE_KEY` may be used instead of the file setting, but never configure both. The
private key is server-only and must not be committed or embedded in a mobile build. Development and
locally signed Release apps register sandbox tokens; distribution builds register production tokens.

## Upstream maintenance

Prefer upstream direct-pairing and direct-push implementations if they become available. Retire
mobile's fail-closed managed-relay compatibility layer once `packages/client-runtime` no longer
requires those services for direct connections.

Take upstream's web cloud files as they are during syncs. The web deltas left here are the `/pair`
link in `ConnectionsSettings.tsx` and the lazy `ConnectOnboardingDialog` in `routes/__root.tsx`.
