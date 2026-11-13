# Stop awaits the run's terminal

## Fork requirement

Stop must not settle a run as interrupted while the provider's own terminal for it is still being
ingested. Providers report their turn's end (`provider_turn.updated`) and the run's terminal
(`turn.terminal`) as separate events. When Stop's follow-up ran between them, it marked the run
interrupted and dropped the terminal, so a usage-limit failure that landed during Stop was lost. On a
loaded host this happened every time and hung `TaskCancelUsageLimit.integration.test.ts` in CI.

## Behavior

`ProviderTurnControlService.interrupt` waits for the turn's run attempt as well as the provider turn.
The attempt ends in the same commit as the run's terminal. The wait was always meant to check the
attempt, but it never asked the projection store for it.

## Removal

Upstream fixed this in #35948 (`15d1ef5e09`), after the fork's last sync. At the next sync, take
upstream's `awaitSettled` in `ProviderTurnControlService.ts` and drop the fork's test case "Stop waits
for the run's terminal after the provider reports its turn's end" in
`ProviderTurnControlService.test.ts`, with the `makeProviderThread` and `makeRuntime` helpers if
nothing else uses them. Upstream's `ProjectionControlReads.test.ts` covers the case. Then delete this
file.
