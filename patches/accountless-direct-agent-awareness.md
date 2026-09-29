# Accountless direct agent awareness

## Fork requirement

This single-user fork must not require a T3 Connect or Clerk account. Web, desktop, and mobile
clients connect only to explicitly paired T3 Code environments. Environment pairing remains the
authorization boundary and is intentionally not removed.

## Implementation

- Web keeps upstream's T3 Connect code in the tree and switched off. Fork builds set no Clerk or
  relay config, so `hasCloudPublicConfig()` is false: `main.tsx` never loads a Clerk shell, Settings
  and the welcome wizard show no T3 Connect sign-in or cloud environments, `/connect` redirects
  home, and the managed relay client gets the disabled `relay.invalid` URL.
- `routes/__root.tsx` lazy-loads `ConnectOnboardingDialog` only when `hasCloudPublicConfig()` is
  true. Upstream imports it statically, which puts `@clerk/react` in the startup graph of every
  build. Fork builds never use it, and the lazy import removes 154 KB (41 KB gzip) of startup
  JavaScript. Clerk code still loads, without effect, when Settings, `/welcome`, or `/connect`
  opens. Drop the gate once upstream lazy-loads the dialog.
- Desktop keeps upstream's Clerk bridge. It holds Electron's single-instance lock and routes
  deeplinks from a second launch, and it stays inert without a publishable key: the renderer never
  mounts Clerk. Signed macOS builds skip the passkey entitlements that only account sign-in needs.
- Pairing links in Connections settings always open the backend's own `/pair` page. The fork ships
  no hosted web app, and an `app.t3.codes` link would load upstream's client against this server.
- Mobile keeps upstream's T3 Connect code in the tree and switched off. Fork builds set no Clerk or
  relay config, so `hasCloudPublicConfig` is false: `CloudAuthProvider` mounts no `ClerkProvider`,
  Settings shows no account row, and the managed relay client gets the disabled `relay.invalid` URL.
- Fork builds must never set a Clerk or relay variable that `resolvePublicConfig` in
  `scripts/lib/public-config.ts` accepts: `T3CODE_CLERK_PUBLISHABLE_KEY`,
  `VITE_CLERK_PUBLISHABLE_KEY`, `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`, `T3CODE_CLERK_JWT_TEMPLATE`,
  `VITE_CLERK_JWT_TEMPLATE`, `EXPO_PUBLIC_CLERK_JWT_TEMPLATE`, `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`,
  `VITE_CLERK_CLI_OAUTH_CLIENT_ID`, `T3CODE_RELAY_URL`, or `VITE_T3CODE_RELAY_URL`. It reads them
  from the process environment and from the repository's root `.env` and `.env.local`. Together
  they turn account sign-in on in web, desktop and mobile. `scripts/mobile-update.ts` and
  `scripts/mobile-testflight.ts` refuse to ship when the public Expo config sets
  `extra.clerk.publishableKey`, `extra.clerk.jwtTemplate`, or `extra.relay.url`, so a stray
  variable on a runner cannot reach the phone.
- Mobile `app.config.ts` still omits the `@clerk/expo` config plugin, Sign in with Apple, and the
  Clerk associated domains. The fork's bundle identifiers and team cannot sign those entitlements.
  The package stays installed and autolinked, so importing its JavaScript is safe without the plugin.
- Upstream's mobile `CloudAuthProvider` mounts Clerk with a key and relay URL even without the JWT
  template. The fork gates it on `hasCloudPublicConfig`, so partial config never loads Clerk. This
  is the only change to upstream's mobile cloud files.
- Drop legacy relay-managed mobile connections during migration; users pair those environments
  directly instead.
- Register an iOS device and its Live Activity update token over the authenticated environment RPC.
  The first reachable saved direct environment owns the device registration. Removing a saved
  environment first asks it to forget the device, so it stops pushing to the phone. That request is
  best effort and bounded to five seconds, so an unreachable server cannot block removal.
- Mobile's Notifications settings always use this direct path and never ask for T3 Connect. The
  relay token hooks that upstream's `CloudAuthProvider` calls in `remoteRegistration.ts` are no-ops.
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

Prefer upstream direct-pairing and direct-push implementations if they become available.

Take upstream's web cloud files as they are during syncs. The web deltas left here are the `/pair`
link in `ConnectionsSettings.tsx` and the lazy `ConnectOnboardingDialog` in `routes/__root.tsx`.

Take upstream's mobile cloud files as they are during syncs, keeping the `CloudAuthProvider` gate.
The other mobile deltas live in upstream-owned files, so check each one survives a merge:

- `features/connection/useConnectionController.ts`: `removeEnvironment` asks the environment to
  forget the device before removing it. The rest of the file is upstream's, so this is the easiest
  delta to lose.
- `features/agent-awareness/remoteRegistration.ts` and `registrationPayload.ts`: rewritten to
  register over the environment RPC instead of the relay. `remoteRegistration.ts` also keeps the
  relay token hooks as no-ops.
- `features/agent-awareness/liveActivityPreferences.ts`: toggling Live Activities updates the
  registration without linking environments to T3 Connect.
- `features/settings/SettingsNotificationsRouteScreen.tsx`: the direct APNs path.
- `features/settings/SettingsRouteScreen.tsx`: the Notifications row in local Settings.
- `connection/migration.ts`: drops legacy relay-managed connections.
- `App.tsx`: mounts the fork-only `AccountlessAgentAwarenessProvider` inside `CloudAuthProvider`.
- `app.config.ts`: the signing removals above.
