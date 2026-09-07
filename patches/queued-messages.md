# Queued messages

Upstream V2 owns queued runs, editing, removal, reordering, and immediate steering. The fork no longer runs a separate V1 queue reactor.

## Retained requirements

- Keep queued work after a failed, cancelled, interrupted, or rolled-back user run. Restart must not silently start that queue.
- A later successful user run allows queued work to continue in order. Removing a never-started queued item does not itself pause the queue.
- Import existing V1 queued messages with their identities, FIFO order, attachments, notification origin, model, runtime mode, and interaction mode intact.
- New client sends use native V2 commands. Saved V1 outbox entries use the compatibility replay RPC so their original setup journal and command identity remain meaningful.

`orchestration-v2/QueuedRunOrder.ts` holds the additional pause policy. `Orchestrator.ts` applies it both when a run finishes and when queued work is resumed. `LegacyV1ThreadImporter.ts` imports old queues and the last terminal state. Web, desktop, and mobile render the native queue.

Prefer upstream policy if it gains the same pause and migration behavior. Do not restore the old queue reactor or subscription workflow.
