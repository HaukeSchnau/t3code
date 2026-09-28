# Queued Messages

## Summary

T3 Code supports queueing user messages while a provider turn is running. On web and desktop, upstream's **Follow-up behavior** client setting decides what a send during a running turn does. **Queue**, the default, creates a durable queued message. **Steer** sends a normal `thread.turn.start`, which the provider applies to the running turn. That is the same path as sending a queued item from the queue strip. The alternate send shortcut does the opposite for one message, and preview annotations always steer, as upstream sends them.

## Behavior

- `thread.message.queue` records a queued user message while the thread is busy. If the command arrives after the thread has already become idle and no older queued item exists, the server immediately dispatches it so a stale running UI state cannot strand a message.
- `thread.queued-message.dispatch` removes the queued item, appends it as a user message, and emits `thread.turn-start-requested`.
- Provider runtime ingestion dispatches the first queued message only after a normal `turn.completed` state of `completed`.
- Failed, cancelled, interrupted, stopped, and manually interrupted turns leave the queue intact.
- Queued messages are projected to SQLite, included in thread detail snapshots, and streamed through `orchestration.subscribeThread`, so they survive app restart/reconnect and update the active chat UI immediately.

Upstream now also offers a browser-local queue that sends at tool boundaries. Keep the server-owned queue here: turn completion controls dispatch, and SQLite makes queued messages available after reconnect and from other clients. Queued attachments and inline context use the same normalization as an immediate send. `shouldQueueFollowUp` in `ThreadTurnSubmission.ts` applies upstream's queue-or-steer decision to this queue for both Chat and Monitor. Mobile keeps its own composer behavior because upstream's mobile app does not read the setting either.

Remove this patch when upstream provides those durability and dispatch guarantees.

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
- ChatView and MonitorView decide queue versus steer through `shouldQueueFollowUp`, and the composer's running send button is labeled for the selected behavior.
