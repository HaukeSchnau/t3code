# SQLite provider event reliability

## Requirement

If T3 cannot record a provider turn's events, it stops that turn before it records the run as
failed. Otherwise the provider keeps working without visible output, and a retry finds the old turn
still active. This follows the October 10 incident where SQLite rejected event writes and Claude
continued in the background.

The stop must only reach the turn this run owns. A stale subscription, a run whose attempt was
replaced, or a provider turn that never reported its id must not interrupt another turn, and server
shutdown leaves the run to restart recovery as before.

## Why upstream does not meet it

Upstream writes writer transactions with `BEGIN IMMEDIATE` in the shared SQLite client, so a
read-to-write upgrade no longer fails under concurrent access (#15488). When ingestion still fails,
upstream fails the run and retries that write until it lands, but never stops the provider.

## Implementation

`apps/server/src/orchestration-v2/RunExecutionService.ts`: the ingestion-failure handler (the
`Effect.catchCauseIf` for causes other than interruption) runs `stopProviderTurnAfterIngestionFailure`
before `writeFinalRunEvents`. It interrupts the root provider turn with
`requestRuntimeRestart: true` only when the turn's id is known, the provider thread's owner was not
lost, and `shouldFinalizeRun` confirms the run's attempt is still current. A failed stop is logged
and the run is still failed.

`RunExecutionService.test.ts` covers the stop, a run that lost ownership, and the upstream recovery
tests with the stop in their recorded order.

## Removal

Drop this patch when upstream stops a provider turn whose events it cannot record.
