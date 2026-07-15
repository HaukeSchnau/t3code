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
  mutation saves the next document before publishing it in memory. Durable save and in-memory publication are
  one uninterruptible commit section, while mutation serialization and unrelated work remain interruptible. A
  failed save leaves observable state unchanged. If interruption arrives after that commit section starts, it
  is observed only after storage and memory agree; interruption before the section leaves both unchanged.

## Delivery requirements

- Build and persist a delivery plan before the first network attempt. `prepareStartThreadTurn` and
  `prepareQueueThreadMessage` create complete commands without requiring a live environment connection.
- Retry transient and ambiguous failures with the exact frozen command and command id. An interrupted
  `Delivering` record becomes an immediate ambiguous retry during startup recovery.
- `cancelPending` is the only pre-delivery cancellation transition. It removes only a `Pending` entry, persists
  that removal before publication, and rejects `Delivering`, `Retrying`, and `Rejected` entries because each may
  represent intent that reached or attempted the network boundary.
- `replacePending` atomically edits only a `Pending` entry in its existing array position. The replacement must
  pass the durable-plan schema, remain in the same environment and thread, and use a new command id that is
  unique across the document. Same-id edits are forbidden even before I/O: replacing ready entry A with new-id
  entry B guarantees a drainer holding a stale snapshot of A cannot begin or dispatch obsolete intent. Once
  `begin` succeeds, pending replacement and cancellation are permanently unavailable and the deeply frozen
  plan identity and payload are reused unchanged by delivery and retry transitions.
- A permanent rejection remains at the thread head. Only `removeRejected` may discard an entry, and it rejects
  pending, delivering, transient-retry, and ambiguous-retry states. Removing a rejected head unblocks the next
  item; edit-and-retry uses the atomic `replaceRejected` transition and must provide a new command id in the
  same environment and thread.
- Only the first item for each `(environmentId, threadId)` can become ready. A delivering, delayed-retry, or
  rejected head blocks that thread but does not prevent another thread from draining.
- Unknown failures default to ambiguous so the core does not silently lose a possibly accepted command.
  Adapters should classify typed business rejections as permanent and may use the shared classifier for known
  unavailable and transport failures.

## Integration notes

- Web and mobile adapters must decode/migrate their platform records into document version 1 and implement an
  atomic replacement write. They should call `begin` immediately before dispatch and dispatch only the frozen
  plan returned by that successful `begin`, never a prior `ready` snapshot. They should then call `complete`
  only after a positive receipt or `fail` with an explicit classification.
- The core does not own reconnects, timers, connection policy, server receipts, or UI. `EnvironmentSupervisor`
  remains the transport reconnect owner; adapters re-evaluate `ready(at)` on connectivity and retry-timer
  changes.
- Storage implementations must preserve document order. They may use a transaction, atomic file replacement,
  or an equivalent platform primitive, but must never expose a partially replaced snapshot.

### Web adapter

- `apps/web/src/durableCommandOutbox.ts` persists the versioned document in a dedicated IndexedDB database.
  Composer submission waits for that transaction, not for the environment RPC, so an unavailable WebSocket
  does not make accepted local intent look like a failed send.
- The adapter owns one drain loop. It retries ready thread heads on the shared bounded backoff and wakes the
  loop when the browser reports that it is online or foregrounded. RPC success is the durable acknowledgement;
  ambiguous response loss keeps the frozen command in the outbox and retries the same command id.
- Chat rendering projects persisted outbox messages alongside the existing in-memory optimistic messages and
  server snapshot, deduplicated by message id. This makes reload recovery visible without rendering two copies
  while the server projection catches up.
- Connection loss no longer disables the ordinary Send or Queue action. Non-replayable actions, approval
  responses, and prior-message editing retain their existing online requirements.

## Maintenance notes

When syncing upstream, keep the durable command allowlist explicit and compare it against orchestration command
semantics. A new command belongs in this outbox only when duplicate delivery under the same command id is safe
and server receipt/idempotency behavior is covered. If the contracts package later exports a dedicated durable
command schema, replace the local refinement rather than duplicating command payload schemas here.

## Verification

- Focused operation, schema, persistence-order, lifecycle, retry, FIFO, rejection, and crash-recovery tests in
  `packages/client-runtime/src/operations/commands.test.ts`,
  `packages/client-runtime/src/operations/commandOutbox.test.ts`, and
  `packages/client-runtime/src/state/commandOutbox.test.ts`. The state tests cover every lifecycle for pending
  edit/cancel, stale-ready invalidation, mandatory new IDs, duplicate IDs, durable-plan validation,
  FIFO/thread-head behavior,
  storage failure, and interruption during asynchronous saves.
- `apps/web/src/durableCommandOutbox.test.ts` covers offline persistence, reconnect draining,
  acknowledgement-loss replay with a stable identity, hydration after a new runtime, and exactly-one
  optimistic projection.
- Client-runtime typecheck plus repository `vp check` and `vp run typecheck` gates.
