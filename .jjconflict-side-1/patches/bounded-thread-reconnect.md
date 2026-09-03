# Bounded Thread Reconnect Catch-up

## Purpose

Keep durable thread-detail subscriptions current without replaying stale history or allowing a
monitor full of visible threads to start every reconnect catch-up simultaneously.

## Contract

- Durable subscription input factories are sampled for every session attempt and every configured
  expected-failure retry. Existing static subscription APIs remain available and retain their
  behavior.
- Thread detail subscriptions read their current applied sequence immediately before each attempt.
  A zero cursor omits `afterSequence` so a cold client receives a snapshot; otherwise the latest
  sequence is sent.
- Thread catch-up admission is opt-in and scoped to an RPC session. At most three thread-detail
  catch-ups may run concurrently. Shell, terminal, authentication, and other subscriptions are not
  admitted through this gate.
- Admission limits are normalized before subscription work and must be positive safe integers. A
  logical group owns exactly one limit per session; conflicting configurations fail with the group
  and both limits instead of silently creating an independent gate.
- A permit is released on the first synchronization marker. The live stream continues without
  holding it. Failure, interruption, and session replacement release through the scoped finalizer,
  and release is idempotent. Permit acquisition is interruptible so a cancelled queued waiter does
  not block session teardown or retain its FIFO position.
- Each replacement `RpcSession` owns a fresh weakly referenced gate. Pending work from an obsolete
  session cannot consume the replacement session's capacity.

## Verification

- `packages/client-runtime/src/state/threads-sync.test.ts` proves same-session retries resume from
  the latest applied event sequence. Its replacement test advances the supervisor generation and
  uses distinct client queues to prove old-transport cancellation and cursor freshness.
- `packages/client-runtime/src/rpc/client.test.ts` drives eight subscriptions deterministically and
  proves 3/3/2 admission waves, continued liveness after synchronization, validation and conflict
  failures, finalizer-before-retry ordering, queued-waiter cancellation, exact-once release for
  duplicate synchronization markers, failure/interruption release, and independent capacity for a
  replacement session.

## Maintenance

Retain this patch while upstream durable subscriptions accept only eager inputs or allow unbounded
thread-detail catch-up fan-out. If upstream adds equivalent per-attempt inputs and bounded catch-up,
prefer its implementation only if permits are released before the live phase and all interruption
paths remain covered.
