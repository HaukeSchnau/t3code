# Accountless direct agent awareness

## Fork requirement

This single-user fork must not require a T3 Connect or Clerk account. Web, desktop, and mobile
clients connect only to explicitly paired T3 Code environments. Environment pairing remains the
authorization boundary and is intentionally not removed.

## Implementation

- Remove account sign-in, account settings, cloud discovery, cloud-link dialogs, and browser OAuth
  routes from the web and desktop clients.
- Pairing links in Connections settings always open the backend's own `/pair` page. The fork ships
  no hosted web app, and an `app.t3.codes` link would load upstream's client against this server.
- Web keeps the upstream managed-relay interfaces behind a fail-closed compatibility layer so shared
  connection runtime types do not need a fork-wide rewrite. No account credential is read or sent.
- Mobile keeps upstream's T3 Connect code unchanged and switched off. Fork builds set no Clerk or
  relay config, so `hasCloudPublicConfig` is false: `CloudAuthProvider` mounts no `ClerkProvider`,
  Settings shows no account row, and the managed relay client gets the disabled `relay.invalid` URL.
  Fork builds must never set `T3CODE_CLERK_PUBLISHABLE_KEY`, `T3CODE_CLERK_JWT_TEMPLATE`, or
  `T3CODE_RELAY_URL`. Together they turn account sign-in on.
- Mobile `app.config.ts` still omits the `@clerk/expo` config plugin, Sign in with Apple, and the
  Clerk associated domains. The fork's bundle identifiers and team cannot sign those entitlements.
  The package stays installed and autolinked, so importing its JavaScript is safe without the plugin.
- Upstream's `CloudAuthProvider` mounted Clerk with a key and relay URL even without the JWT
  template. The fork gates it on `hasCloudPublicConfig`, so partial config never loads Clerk.
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

Prefer upstream direct-pairing and direct-push implementations if they become available. Retire
web's fail-closed managed-relay compatibility layer once `packages/client-runtime` no longer requires
those services for direct connections.

Take upstream's mobile cloud files as they are during syncs. The fork's mobile deltas are the
`CloudAuthProvider` gate, the relay hook no-ops, `AccountlessAgentAwarenessProvider` in `App.tsx`,
the Notifications screen, the Notifications row in local Settings, and the `app.config.ts` signing
removals.
