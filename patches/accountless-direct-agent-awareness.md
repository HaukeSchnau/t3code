# Accountless direct agent awareness

## Fork requirement

This single-user fork must not require a T3 Connect or Clerk account. Web, desktop, and mobile
clients connect only to explicitly paired T3 Code environments. Environment pairing remains the
authorization boundary and is intentionally not removed.

## Implementation

- Remove account sign-in, account settings, cloud discovery, cloud-link dialogs, and browser OAuth
  routes from the clients.
- Keep the upstream managed-relay interfaces behind fail-closed compatibility layers so shared
  connection runtime types do not need a fork-wide rewrite. No account credential is read or sent.
- Drop legacy relay-managed mobile connections during migration; users pair those environments
  directly instead.
- Register an iOS device and its Live Activity update token over the authenticated environment RPC.
  The first reachable saved direct environment owns the device registration. Unregistration is sent
  to every saved direct environment so stale device records are removed.
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

Prefer upstream direct-pairing and direct-push implementations if they become available. Retire the
fail-closed managed-relay compatibility layers once `packages/client-runtime` no longer requires
those services for direct connections.
