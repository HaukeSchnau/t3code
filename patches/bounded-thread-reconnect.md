# Bounded thread reconnect catch-up

## Requirement

A reconnect with many mounted threads must not start every thread catch-up at once. Upstream
replays every thread-detail subscription concurrently after a reconnect, which floods the server
and the client with simultaneous replays. At most three thread catch-ups may run at a time per
RPC session.

## Implementation

- `SubscriptionOptions.admission` in `packages/client-runtime/src/rpc/client.ts` takes `group`,
  `maxConcurrent`, `appliesTo(input)` and `releaseWhen(value)`. Each RPC session gets its own
  semaphore per group, so a replacement session never inherits permits from the old one. A second
  subscription that names the same group with a different limit fails instead of creating another
  gate.
- A subscription holds its permit from subscribe until the first value that `releaseWhen` accepts.
  The live phase holds no permit. Failure and interruption release it through the scope
  finalizer, at most once. Waiting for a permit is interruptible, and admission keeps transport
  batches intact.
- `state/threads.ts` admits thread-detail subscriptions in the `thread-detail-catch-up` group with
  three permits. Only inputs that set `requestCompletionMarker` take a permit, because only those
  streams emit the `synchronized` item that releases it.

## Removal

Retire this patch when upstream bounds concurrent thread catch-up and releases capacity before the
live phase.

## Verification

The "thread catch-up admission" tests in `packages/client-runtime/src/rpc/client.test.ts`.
