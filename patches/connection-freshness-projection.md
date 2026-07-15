# Shared Connection Freshness Projection

## Goal

Give web and mobile one typed, read-only description of environment connection progress and cached
shell freshness. The projection exposes the supervisor's current setup stage, attempt, generation,
failure, and absolute retry time alongside the shell snapshot's categorical freshness and identity.

## Ownership

- `EnvironmentSupervisor` remains the only owner of desired connection state, retry scheduling, and
  replacement sessions.
- The projection observes `SupervisorConnectionState`; it never calls `connect`, `retryNow`, or any
  transport/session API.
- `retryAt` is copied unchanged as an absolute epoch time. `retryRemainingMs` only compares it with a
  caller-provided observation time and owns no clock or timer.
- Shell freshness is independent from transport readiness. A connected environment may still have
  empty, cached, synchronizing, or live shell data, including a cached synchronization error.

## Snapshot Coupling

The public snapshot identity keeps `snapshotSequence` and the server-authored `updatedAt` value in one
object. Consumers cannot independently retain a cursor from one snapshot and content time from
another. `updatedAt` is not presented as a client receipt time and is not used for age-based stale
heuristics.

## Compatibility

The existing coarse `EnvironmentConnectionPresentation` remains unchanged. Platform adoption and UI
copy belong to later web and mobile UX packets; this patch only provides the shared pure projection.

## Source Invariants

The existing supervisor and shell source interfaces use nullable fields rather than discriminated
unions, so TypeScript can represent combinations their state machines never publish. The projection
checks those boundaries and fails explicitly instead of emitting an invalid public union, such as a
backoff without `retryAt` or cached freshness without a snapshot.

## Verification

Focused tests cover every connection phase, active setup stages, exact retry-time observation,
snapshot identity coupling, retained cached data, transport/freshness independence, and rejection of
impossible nullable source combinations.
