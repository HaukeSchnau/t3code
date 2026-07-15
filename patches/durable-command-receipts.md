# Durable Command Receipts

T3 Code persists one command receipt per orchestration command ID. This fork-specific reliability
boundary lets clients safely retry an immutable command after a transport failure makes its
acknowledgement ambiguous.

## Required behavior

- An accepted `thread.turn.start` or `thread.message.queue` retry with the same command ID and thread
  returns the original terminal event sequence. It does not append or republish domain events, so a
  provider reactor cannot issue a second logical request.
- A rejected command ID remains rejected even if the read-model condition that caused the rejection
  later becomes valid.
- A command ID accepted for one aggregate cannot be reused for another aggregate. A rejected command
  ID also remains rejected when presented for another aggregate.
- Rejecting cross-aggregate reuse must not overwrite the command ID's original terminal receipt.
- Receipt acceptance is committed in the same SQLite transaction as the command's events and
  projections.

These guarantees intentionally key on command identity and aggregate ownership. The receipt does not
store a payload fingerprint, so callers must freeze the command variant and payload before the first
network attempt and reuse that exact command for ambiguous retries.

## Regression coverage

`apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts` simulates a lost acknowledgement for
turn start and server-side message queue commands. The tests assert the original sequence is replayed,
the command's event count is unchanged, exactly one provider-intent event is published, rejected IDs
are sticky, and cross-thread command-ID reuse is rejected.

No schema migration is required by this patch; it documents and locks in the existing durable receipt
implementation. The engine fix is deliberately narrow: its invariant-error path only inserts a
rejection when dispatch began without an existing receipt, preserving the original terminal result
when reuse itself is the invariant violation.
