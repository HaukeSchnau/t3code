# Provider work scheduling

Provider commands and runtime events are ordered within a thread, but independent threads must not share a
single execution lane. Session startup, transcript recovery, persistence retries, and large tool-event bursts
can each take seconds or minutes; globally serial execution makes an unrelated accepted turn appear stuck.

## Requirements

- Provider command and runtime ingestion work is FIFO within each orchestration thread.
- Independent threads run concurrently with a fixed global concurrency bound.
- A noisy thread is requeued after each item so it cannot monopolize an execution lane.
- `drain` completes only when all queued and active items across every thread have settled.
- Transcript-journal delivery remains ordered within its thread and does not let concurrent threads process
  each other's undelivered entries.
- Thread detail replay uses the indexed aggregate stream; it must not scan and decode unrelated global events
  before filtering to the selected thread.

## Files

- `packages/shared/src/KeyedDrainableWorker.ts`
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
- `apps/server/src/orchestration/Layers/ProviderTranscriptJournalIngestion.ts`
- `apps/server/src/persistence/Layers/OrchestrationEventStore.ts`
- `apps/server/src/orchestration/transport/OrchestrationSubscriptionWorkflow.ts`

## Verification

- `vp test packages/shared/src/KeyedDrainableWorker.test.ts`
- `vp test apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`
- `vp test apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`
- `vp run --filter t3 typecheck`

## Upstream notes

Revisit this patch if upstream introduces keyed provider actors, per-session runtime inboxes, or another
bounded scheduler that preserves per-thread ordering. Do not return these reactors to one global FIFO worker.
