# Snapshot single-flight

## Purpose

Coalesce concurrent materialization of the same orchestration snapshot across HTTP and WebSocket transports.
Reconnects and monitor views can request the same expensive SQL snapshot simultaneously; previously each
request repeated the full transaction and cancellation of a connection discarded work other callers still
needed.

## Behavior

`ProjectionSnapshotMaterializer` is allocated once in the server orchestration layer. It samples the current
projection sequence, then shares only the in-flight computation for an exact full, shell, or thread key.
Disconnecting one waiter does not cancel the layer-owned loader. Successes, failures, and missing-thread
results are removed immediately after completion, so later calls always re-observe projection state.

## Requirements

- HTTP and WebSocket snapshot paths must use the same server-scoped materializer.
- Keys include snapshot kind, observed projection sequence, and thread id where applicable.
- A caller interruption may cancel its wait but never another caller's shared materialization.
- Failures and completed values must not remain cached.
- Server layer shutdown must interrupt outstanding loaders.
- An older loader may remove only its own exact in-flight entry.

## Maintenance risk

Do not move this state into the per-connection WebSocket RPC layer. During upstream syncs, preserve the
in-flight-only lifetime unless the projection watermark is strengthened to prove completed snapshots cannot
become stale while the sequence remains unchanged.
