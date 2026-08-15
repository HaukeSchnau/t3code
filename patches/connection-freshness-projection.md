# Shared Connection Freshness Projection

## Goal

Give web and mobile one typed, read-only description of environment connection progress and cached
shell freshness. The projection exposes the supervisor's current setup stage, attempt, generation,
failure, and absolute retry time alongside the shell snapshot's categorical freshness and identity.

## Ownership

- `EnvironmentSupervisor` remains the only owner of desired connection state, retry scheduling, and
  replacement sessions.
- Browser connectivity is advisory while an environment connection is desired. A reported offline
  state is normalized to unknown before initial setup, automatic recovery, and explicit retry so a
  stale `navigator.onLine` value cannot park a reachable transport. Connection attempts and their
  bounded backoff remain the authority for reachability.
- The projection observes `SupervisorConnectionState`; it never calls `connect`, `retryNow`, or any
  transport/session API.
- `retryAt` is copied unchanged as an absolute epoch time. `retryRemainingMs` only compares it with a
  caller-provided observation time and owns no clock or timer.
- Shell freshness is independent from transport readiness. A connected environment may still have
  empty, cached, synchronizing, or live shell data, including a cached synchronization error.

## Snapshot Coupling and Cross-Source Reconciliation

The public snapshot identity keeps the content snapshot's embedded `snapshotSequence` (exposed as
`contentSequence`) and server-authored `updatedAt` in one object. This is not the shell state's private
durable replay cursor: cursor-only frames can advance `lastSequence` and the persisted resume point
without changing the published content snapshot. `updatedAt` is not presented as a client receipt time
and is not used for age-based stale heuristics.

Supervisor and shell refs update independently. If the combined projector observes a non-connected
connection while the shell still reports `live`, it retains the snapshot but downgrades freshness to
`cached`. It never publishes live freshness without a connected transport.

## Compatibility

The existing coarse `EnvironmentConnectionPresentation` remains unchanged. Platform adoption and UI
copy belong to later web and mobile UX packets; this patch only provides the shared pure projection.

Warm shell and thread subscriptions opt in to a terminal `synchronized` stream item. The server emits it after
persisted catch-up and before buffered live events; older clients receive no marker unless they request it. The
client binds the proof to the immutable RPC session and supervisor generation captured when that subscription is
created. A marker from a replaced session, a lower generation, or a generation that has since disconnected
cannot promote cached data to live.

Replay diagnostics execute inside the returned long-lived WebSocket stream. `websocketRpcRouteLayer` therefore
captures its server-owned `ReplayLogPublisher` while constructing the route and explicitly provides that service
to deferred shell/thread replay observers. Do not move this lookup back inside stream execution: the route-build
context is gone by then, which makes every warm catch-up fail while the full-snapshot path continues to work.

## Source Invariants

The existing supervisor and shell source interfaces use nullable fields rather than discriminated
unions, so TypeScript can represent combinations their state machines never publish. The projection
checks those boundaries and fails explicitly instead of emitting an invalid public union, such as a
backoff without `retryAt`, a retry carrying a blocked failure, a non-positive active attempt, a phase
that contradicts desired/network state, or cached freshness without a snapshot.

## Verification

Focused tests cover every connection phase, active setup stages, exact retry-time observation,
snapshot identity coupling, retained cached data, transport/freshness independence, and rejection of
impossible nullable source combinations. They also cover the immediate disconnect/backoff/blocked
cross-source race, initial and automatic recovery from stale offline signals, and cursor-only
content-sequence semantics. RPC/state tests cover replaced-session and stale generation marker races, genuine
same-generation loss, deleted/no-data states, and a real WebSocket catch-up through both the shell
and thread synchronization markers.
