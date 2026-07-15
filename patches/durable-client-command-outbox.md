# Durable client command outbox

## Why this patch exists

Web and mobile clients need to accept user messages while an environment is disconnected or an
acknowledgement is lost. Retrying an RPC assembled from current UI state can change its payload or identity,
while treating a lost acknowledgement as a rejection can lose a command that the server already accepted.
The shared client runtime therefore owns a small durable-delivery state machine; platform clients only supply
storage and decide when to drain ready thread heads.

## Public model and storage contract

- `@t3tools/client-runtime/operations/command-outbox` exports the versioned delivery-plan and persisted-document
  schemas. A plan freezes the environment, enqueue timestamp, command variant, command id, and complete payload.
- The durable allowlist contains only `thread.turn.start` and `thread.message.queue`. Approval responses,
  interrupts, queued-message controls, VCS operations, terminal input, preview automation, and arbitrary RPC
  methods must not be replayed through this outbox without a separate safety audit.
- Document schema version 1 is an ordered array. Array position is the FIFO authority, including when an edited
  rejected head receives a replacement plan whose enqueue timestamp is newer.
- Outbox lifecycle timestamps use canonical UTC ISO strings. Lifecycle states are `Pending`, `Delivering`,
  `Retrying`, and `Rejected`; retry and rejection records retain the attempt count and typed failure
  classification (`transient`, `ambiguous`, or `permanent`).
- `CommandOutboxStorage` is a platform service with `load` and atomic whole-document `save`. The shared package
  intentionally contains no IndexedDB, filesystem, Expo, React, or React Native implementation.
- `@t3tools/client-runtime/state/command-outbox` exports the serialized state machine and Effect layer. Every
  mutation saves the next document before publishing it in memory. A failed save leaves observable state
  unchanged.

## Delivery requirements

- Build and persist a delivery plan before the first network attempt. `prepareStartThreadTurn` and
  `prepareQueueThreadMessage` create complete commands without requiring a live environment connection.
- Retry transient and ambiguous failures with the exact frozen command and command id. An interrupted
  `Delivering` record becomes an immediate ambiguous retry during startup recovery.
- A permanent rejection remains at the thread head. Removing it unblocks the next item; edit-and-retry uses the
  atomic `replaceRejected` transition and must provide a new command id in the same environment and thread.
- Only the first item for each `(environmentId, threadId)` can become ready. A delivering, delayed-retry, or
  rejected head blocks that thread but does not prevent another thread from draining.
- Unknown failures default to ambiguous so the core does not silently lose a possibly accepted command.
  Adapters should classify typed business rejections as permanent and may use the shared classifier for known
  unavailable and transport failures.

## Integration notes

- Web and mobile adapters must decode/migrate their platform records into document version 1 and implement an
  atomic replacement write. They should call `begin` immediately before dispatch, then `complete` only after a
  positive receipt or `fail` with an explicit classification.
- The core does not own reconnects, timers, connection policy, server receipts, or UI. `EnvironmentSupervisor`
  remains the transport reconnect owner; adapters re-evaluate `ready(at)` on connectivity and retry-timer
  changes.
- Storage implementations must preserve document order. They may use a transaction, atomic file replacement,
  or an equivalent platform primitive, but must never expose a partially replaced snapshot.

## Maintenance notes

When syncing upstream, keep the durable command allowlist explicit and compare it against orchestration command
semantics. A new command belongs in this outbox only when duplicate delivery under the same command id is safe
and server receipt/idempotency behavior is covered. If the contracts package later exports a dedicated durable
command schema, replace the local refinement rather than duplicating command payload schemas here.

## Verification

- Focused operation, schema, persistence-order, lifecycle, retry, FIFO, rejection, and crash-recovery tests in
  `packages/client-runtime/src/operations/commands.test.ts`,
  `packages/client-runtime/src/operations/commandOutbox.test.ts`, and
  `packages/client-runtime/src/state/commandOutbox.test.ts`.
- Client-runtime typecheck plus repository `vp check` and `vp run typecheck` gates.
