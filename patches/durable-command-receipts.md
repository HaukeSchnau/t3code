# Durable Command Receipts

T3 Code persists one immutable terminal receipt per orchestration command ID. This fork-specific
reliability boundary lets clients retry a command after a transport failure makes its acknowledgement
ambiguous without issuing the command's effects twice.

## Required behavior

- Every new receipt stores the command variant and a SHA-256 fingerprint of the complete decoded
  command envelope. The envelope is serialized with recursively sorted object keys, omitted undefined
  object properties, and stable array order.
- Replay requires the same command ID, aggregate kind and ID, command variant, and envelope
  fingerprint. Aggregate, variant, and payload mismatches return a typed permanent
  `OrchestrationCommandReceiptMismatchError` without changing the original receipt.
- An accepted `thread.turn.start` or `thread.message.queue` retry returns the original terminal event
  sequence. It does not append or republish domain events, so a provider reactor cannot issue a second
  logical request.
- A rejected command ID remains rejected only after its rejection receipt is durable. A receipt write
  failure is returned as a persistence/ambiguous failure, allowing a later retry to evaluate the
  command again instead of claiming a rejection was recorded.
- Receipt rows are immutable once committed. Inserts use conflict-safe claim semantics and never
  overwrite an accepted or rejected terminal result.
- Receipt acceptance is committed in the same SQLite transaction as the command's events and
  projections.

## WebSocket preprocessing boundary

Durable receipt identity also covers preprocessing that occurs before orchestration events are
committed:

- Upload attachment ids are derived from the command id, attachment position, declared metadata,
  and payload content. Normalization produces the durable command envelope without writing files.
  The WebSocket path first validates that envelope against any existing receipt and materializes
  attachment bytes only for a command id with no receipt. Existing identical bytes are accepted,
  while an identity collision fails closed.
- Receipt lookup uses the same aggregate, variant, canonical fingerprint, rejection, and legacy
  validation as engine dispatch. It is read-only and cannot mutate or replace a receipt.
- Preprocessing is serialized per command id, so concurrent WebSocket retries cannot both cross the
  no-receipt boundary. Different command ids remain independent.
- Bootstrap metadata remains part of the `thread.turn.start` envelope passed to the engine. The
  decider deliberately omits bootstrap instructions from domain events, but the receipt fingerprint
  includes them. WebSocket bootstrap checks the full receipt before thread, workspace/worktree, setup
  script, or attachment side effects, so commit-then-lost-ack replay returns the original sequence.

This boundary does not make a never-committed bootstrap transaction atomic with filesystem or setup
script effects. A process crash after bootstrap begins but before the final turn receipt commits can
still require existing workspace/setup recovery behavior. RC2 specifically closes exact concurrent
replay and replay after a committed command whose acknowledgement was lost.

## Claim and transaction boundary

The engine still serializes dispatch through one in-process queue. To protect a duplicate command ID
when two engine instances nevertheless point at the same SQLite file, the accepted path inserts a
provisional receipt claim as the transaction's first write. Only the transaction that inserted the
claim may append events and projections. It then compare-and-set finalizes the receipt sequence before
commit. The provisional row is never committed independently: failure or process interruption rolls
back the claim together with all effects.

A competing writer uses `INSERT ... ON CONFLICT DO NOTHING`, then reads and validates the winning
terminal receipt inside its transaction. This prevents duplicate effects for the same command ID.
T3 Code otherwise remains a single-server/single-writer runtime: separate engines have independent
in-memory read models, and this patch does not attempt general multi-writer ordering for different
commands on the same aggregate. SQLite lock contention may therefore surface as an ambiguous
persistence failure; retrying the immutable command resolves through the winning receipt.

## Migration and backward compatibility

Migration 38 adds nullable `command_variant` and `envelope_fingerprint` columns. They are nullable only
because existing receipts do not contain enough information to reconstruct the complete original
command envelope. New repository writes always supply both values.

Legacy receipts are preserved unchanged and fail closed with the typed `legacy-unverifiable` mismatch.
They are never replayed and never permit the command ID to execute again. This intentionally favors
duplicate-effect safety over acknowledgement replay compatibility for commands accepted before the
migration.

## Regression coverage

`apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts` covers exact ambiguous retries,
meaningful field mismatch for both durable variants, cross-variant and cross-aggregate reuse, sticky
rejections, accepted-receipt preservation, legacy fail-closed behavior, injected accepted and rejected
receipt failures, restart after an ambiguous rejected-receipt failure, and shared-file contention
between two engine instances. It also verifies the read-only receipt resolver uses the same exact,
mismatch, and legacy rules as dispatch.

`apps/server/src/server.test.ts` covers the WebSocket preprocessing seam for attachment-free and
image-bearing turn start/message queue commands, concurrent replay, changed image payload reuse,
commit-then-lost-ack replay, and local, worktree, and explicit-workspace bootstrap replay without
repeated thread/workspace/setup resources.

`apps/server/src/persistence/Migrations/038_OrchestrationCommandReceiptEnvelopes.test.ts` verifies that
the migration preserves existing terminal receipt data while marking its missing envelope identity as
legacy and unverifiable.
