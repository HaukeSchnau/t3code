# Offline cached web bootstrap

## Why this patch exists

A paired web client previously blocked its root route on `/api/auth/session` and rebuilt the primary environment
registration through a live descriptor request. Reloading while the remote server was unreachable therefore
showed a fatal 502 screen before the durable outbox and cached shell/thread state could hydrate.

## Security boundary

- A successful `authenticated: true` response persists only a version, browser origin, normalized primary HTTP
  and WebSocket target signature, and the server session expiry. Both auth proof and descriptor use the canonical
  signature owned by the primary-target module. The proof stores no cookie, session id, bearer/bootstrap/pairing
  credential, or pairing URL.
- Cache-only startup is a distinct `offline-authenticated` gate. It is allowed only while that exact-target proof
  is unexpired and the live check fails with a transport/abort error or HTTP 502, 503, or 504.
- First-time, corrupt, expired, or target-mismatched state fails closed. Authoritative `authenticated: false`,
  401, and 403 results clear the proof; 400, 404, and 500 never use the fallback.
- Privileged authenticated-only root components stay disabled in degraded mode. Server authorization and command
  receipts remain the authority for reconnect and outbox delivery.

## Cached primary identity

The web connection platform persists the schema-decoded, non-secret primary environment descriptor under the
same exact origin/HTTP/WS signature. During cold offline startup it reconstructs a primary registration so the
existing environment-scoped IndexedDB caches can attach. The registration remains refreshable; if the live
descriptor later reports a different environment id, registry reconciliation releases the old runtime, removes
its entry, clears its shell and owned data, and installs the new identity instead of mixing caches.

## Revalidation and expiry

Degraded startup revalidates with bounded exponential backoff and wakes on online/foreground events. Success
promotes the route; authoritative denial ejects it to the normal auth flow. Proof expiry is enforced independently
of a pending request. Expiry waits are scheduled in 24-hour chunks and recalculate remaining time, avoiding the
signed 32-bit browser timer overflow for the normal 30-day session lifetime.

Each controller attempt performs exactly one auth request; it must not call the 15-second initial-bootstrap retry
loop inside its own retry loop. The authoritative result is handed to the next route invalidation without a second
request. Primary descriptor refresh failures retain only a registration with the exact same target signature and
back off from the platform poll interval to a capped 60-second delay; a changed target can never inherit the old
runtime while discovery is unavailable.

## Verification

- Auth bootstrap tests cover the transient allowlist, fail-closed statuses, target binding, secret-free storage,
  and invalid/expired/corrupt proof.
- Revalidation controller tests cover 30-day chunked expiry, promotion, ejection, retry interruption, and wakeups.
- Platform tests cover persisted descriptor decoding and replacement, while the real environment-registry test
  proves changed-id runtime/cache isolation.
- Browser evidence covers server stop, cold page reload with cached content and queued intent, then automatic
  recovery without a fatal root route or stuck freshness banner.
