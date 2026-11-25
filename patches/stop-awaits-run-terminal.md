# Stop awaits the run's terminal

## Fork requirement

Stop must not settle a run as interrupted while the provider's own terminal for it is still being
ingested. Providers report their turn's end (`provider_turn.updated`) and the run's terminal
(`turn.terminal`) as separate events. When Stop's follow-up ran between them, it marked the run
interrupted and dropped the terminal, so a usage-limit failure that landed during Stop was lost. On a
loaded host this happened every time and hung `TaskCancelUsageLimit.integration.test.ts` in CI.

## Behavior

`ProviderTurnControlService.interrupt` waits for the turn's run attempt as well as the provider turn,
through upstream's event-driven `awaitSettled` (#35948). The attempt ends in the same commit as the
run's terminal. Upstream waits only when the loaded turn is still running, so it misses a turn that
ended before Stop loaded it while its attempt still runs. The fork drops that guard and always
waits, bounded by upstream's 2-second timeout. A turn without a run attempt waits on the turn alone.

## Removal

Once upstream also waits for the attempt of a turn that had already ended, take its
`ProviderTurnControlService.ts` as is and delete this file. Then drop the test "Stop waits for the
run's terminal when its turn ended before Stop loaded it" in `ProviderTurnControlService.test.ts`,
and the `makeProviderThread` and `makeRuntime` helpers if nothing else uses them. Upstream's
`ProjectionControlReads.test.ts` covers the running-turn case.
