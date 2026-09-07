# Provider work scheduling

V2 owns provider work at three native boundaries. `ThreadCommandExecutor` serializes planning and
commit for one thread, so a command observes the projection produced by the preceding command. The
queue projection and `startNextQueuedRun` promote at most one queued run after a terminal run. The
provider event pump and `RunExecutionService` consume each provider run stream serially, while
independent threads remain concurrent.

## Effect boundary

`EffectOutboxV2` is the durable side-effect scheduler. It allows one running non-title effect per
thread and one independent title-generation lane. `OrchestrationEffectWorkerV2` has a fixed process-local
concurrency bound (four by default); durable `available_at` timestamps wake retries without making a
delayed retry block unrelated ready work. This is a scheduling bound, not a promise that every effect
type shares one FIFO order.

Lifecycle commands cancel pending or running process-bound effects before their detached or switched
provider state can be reopened. Archive, provider switch, and model-selection change use the shared
`PROCESS_BOUND_EFFECT_TYPES` set; interruption and runtime recovery use the same cancellation path.

## Boundaries and verification

The former V1 keyed worker requirement does not apply to the V2 path. The V2 ordering guarantees are
the command lock, the queued-run projection, the per-run provider event stream, and the outbox's
per-thread active lane. Do not add a generic predecessor gate or a second provider FIFO worker: it
would delay urgent lifecycle controls behind a retry-delayed provider effect.

The relevant implementation and focused tests are:

- `apps/server/src/orchestration-v2/ThreadCommandExecutor.ts`
- `apps/server/src/orchestration-v2/Orchestrator.ts`
- `apps/server/src/orchestration-v2/EffectOutbox.ts`
- `apps/server/src/orchestration-v2/EffectWorker.ts`
- `apps/server/src/orchestration-v2/RunExecutionService.ts`
- `apps/server/src/orchestration-v2/runtimeLayer.test.ts`
- `apps/server/src/orchestration-v2/FoundationPersistence.test.ts`

Revisit this patch if upstream changes these V2 ownership boundaries or introduces a keyed provider
actor. Keep the native command, run, and effect lanes as the single source of ordering behavior.
