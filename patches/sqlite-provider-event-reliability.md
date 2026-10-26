# SQLite provider event reliability

## Requirement

If T3 cannot record a provider turn's events, it stops that turn before it records the run as
failed. Otherwise the provider keeps working without visible output, and a retry finds the old turn
still active. This follows the October 10 incident where SQLite rejected event writes and Claude
continued in the background.

The stop must only reach the turn this run owns. A stale subscription or a run whose attempt was
replaced must not restart a runtime that a newer run uses.

## Why upstream does not meet it

Upstream now interrupts the root provider turn with `requestRuntimeRestart: true` when ingestion
fails (#23169, #22846), and the next start recovers a turn whose interrupt failed. It does not check
whether this run still owns the provider thread before interrupting.

## Implementation

`apps/server/src/orchestration-v2/RunExecutionService.ts`: the ingestion-failure handler adds
`ownsProviderThread` to upstream's interrupt condition. The run owns the thread unless
`providerThreadOwnerLost` is set or `shouldFinalizeRun` returns false or fails.

`RunExecutionService.test.ts` ("does not interrupt the provider after a failed ingestion loses
ownership to a newer run") covers the guard. Upstream's ingestion-failure tests cover the stop.

## Removal

Drop this patch when upstream checks ownership before its ingestion-failure interrupt.
