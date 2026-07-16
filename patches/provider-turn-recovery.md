# Provider turn recovery

T3 Code keeps provider runtime events and UI projection state separate. A user turn can be accepted by the
provider while the projection still only knows about the local `thread.turn-start-requested` placeholder. If
the bridge event that carries the concrete provider turn id is delayed, skipped, or lost during shutdown, that
placeholder must not leave the thread looking permanently busy.

## Requirements

- When the command reactor begins an accepted turn, it must durably publish a `starting` session before
  provider session resume/start work can block. Shell and detail clients already map `starting` to visible
  connecting/working state.
- When a `thread.session-set` event leaves `running` with no active turn, any pending turn-start placeholder
  for the thread must become terminal instead of remaining `pending`.
- Pending placeholders without a concrete provider turn id are settled as `interrupted` for ready, idle,
  stopped, and interrupted sessions. They are settled as `error` for error sessions.
- Concrete running turns keep the existing behavior: ready and idle settle them as completed, interrupted and
  stopped settle them as interrupted, and error settles them as error.
- Tool activity payloads projected from provider runtime events must preserve useful structured metadata while
  bounding large strings, arrays, and objects so command output cannot create unbounded projection writes.
- Adjacent durable parent assistant-text deltas for the same provider item are projected as a bounded batch.
  Every original journal row remains associated with that batch so streaming, buffered delivery, and crash
  recovery retain the exact transcript while avoiding one full projection write per provider token.

## Files

- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
- `apps/server/src/orchestration/ProviderTranscriptJournalBatch.ts`
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- `apps/server/src/persistence/Services/ProjectionTurns.ts`
- `apps/server/src/persistence/Layers/ProjectionTurns.ts`

## Verification

- `vp test apps/server/src/orchestration/ProviderTranscriptJournalBatch.test.ts apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts apps/server/integration/coalescingHardKill.integration.test.ts`
- `vp check`
- `vp run typecheck`

## Upstream Notes

Revisit this patch if upstream introduces a durable provider-event inbox, provider-log replay, or first-class
turn reconciliation that can recover concrete provider turn ids after projection missed the original runtime
events. The pending-placeholder settlement should remain as a last-resort invariant even if richer replay is
added.
