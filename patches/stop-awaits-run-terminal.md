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
attempt, but it never asked the projection store for it. Each read checks the current turn and attempt,
so Stop also waits when the turn had ended before Stop loaded it and only the attempt still runs. A
turn without a run attempt waits on the turn alone.

The wait gives up after 200 reads 10 ms apart instead of after a 2-second deadline. On a loaded host,
real time could pass that deadline between the test's reads, so the test failed even with the fix.
Stop still gives up on a stalled run after at least 2 seconds, longer on a loaded host.

## Removal

Upstream fixed the running-turn case in #35948 (`15d1ef5e09`), after the fork's last sync. Its
`awaitSettled` still runs only when the loaded turn is running (upstream main, 2026-11-16), so it
misses a turn that ended before Stop loaded it. At the next sync, take upstream's `awaitSettled` in
`ProviderTurnControlService.ts` without that guard. In `ProviderTurnControlService.test.ts`, drop the
row "after the provider reports its turn's end", which upstream's `ProjectionControlReads.test.ts`
covers, and port the row "when its turn ended before Stop loaded it" to upstream's event-driven wait.
Remove the `makeProviderThread` and `makeRuntime` helpers if nothing else uses them. Delete this file
once upstream waits for the attempt of a turn that had already ended.
