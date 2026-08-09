# Queued Messages

## Summary

T3 Code supports queueing user messages while a provider turn is running. Submitting from the composer during a running turn now creates a durable queued message instead of steering immediately. Users can still steer by sending a queued item immediately from the queue strip.

## Behavior

- `thread.message.queue` records a queued user message while the thread is busy. If the command arrives after the thread has already become idle and no older queued item exists, the server immediately dispatches it so a stale running UI state cannot strand a message.
- `thread.queued-message.dispatch` removes the queued item, appends it as a user message, and emits `thread.turn-start-requested`.
- Provider runtime ingestion dispatches the first queued message only after a normal `turn.completed` state of `completed`.
- Failed, cancelled, interrupted, stopped, and manually interrupted turns leave the queue intact.
- Queued messages are projected to SQLite, included in thread detail snapshots, and streamed through `orchestration.subscribeThread`, so they survive app restart/reconnect and update the active chat UI immediately.

## Maintenance Notes

The patch intentionally reuses the existing `thread.turn-start-requested` provider path after dispatch instead of adding provider-specific queue or steer APIs. This keeps provider merge risk low and confines durable queue state to orchestration contracts, decider logic, projections, and the web composer surface.

When syncing upstream, verify:

- `packages/contracts/src/orchestration.ts` still exposes queue command/event schemas.
- `apps/server/src/orchestration/Normalizer.ts` still derives deterministic upload identities for
  `thread.message.queue`, with materialization deferred behind durable receipt/progress validation.
- `apps/server/src/orchestration/transport/OrchestrationSubscriptionWorkflow.ts` still treats queued-message lifecycle events as thread detail events.
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` still dispatches queued messages only after completed turns.
- `apps/web/src/components/chat/useThreadDurableOutbox.ts` owns queued-message send-now/remove controls and optimistic durable-outbox projection for both Chat and Monitor surfaces.
- `apps/web/src/components/chat/QueuedMessagesStrip.tsx` and the composer running actions still expose send-now and remove controls.
