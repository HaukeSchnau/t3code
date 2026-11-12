# Thread waits

## Fork requirement

Hauke can always see what a thread waits on and since when, and a waiting thread can't stall
silently. A retro of his Claude threads from August to November 2026 found three ways it did:

- A Claude background-wake run started, the provider never answered, and the run stayed `running`
  for 4.8 hours. A pull request watch's "checks passed" wake queued behind it the whole time.
- A watched pull request merged and the watch ended without a wake (fixed by
  [pull-request-watch-merge-wake](pull-request-watch-merge-wake.md)).
- A server restart stopped a Claude Monitor the agent had not marked with `t3_background_wait`, and
  nothing woke the thread.

Upstream shows "Waiting" with no reason or start, has no deadline for a wait, never notices a run
that stopped making progress, and wakes after a restart only for work the agent marked.

## Behavior

- A wait is a pending background task that holds the thread in Waiting: a pull request watch, an
  open `t3_watch` watch, a subagent, or a command or monitor the agent marked as awaited. Each task
  carries `startedAt` and, for a `t3_watch` deadline, `expectedBy`.
- Check-in: when a quiet thread's waits pass their check-in time and nothing else woke it, T3 sends
  one `system` notification that lists them. A wait's check-in time is its `expectedBy`, or the time
  the thread went quiet plus as long as the wait had been open by then, from 30 minutes to 4 hours.
  That doubles the gap after each check-in without storing history, so a pull request waiting days
  for review costs about six turns a day. `threadWaitCheckIn` decides who gets one, for the
  watchdog and the clients alike: not settled, archived or native subagent threads, a thread the
  user stopped, one that asks its user something, or one at a usage limit. The watchdog also skips
  a thread with a held queue, which only it can see.
- Stall: a `running` run with no open turn item and no turn item update for 20 minutes is stopped.
  A `system` notification to continue is queued first, so it runs after any wake already waiting
  behind the run. A provider that has not ended the turn two minutes after that Stop is
  force-stopped, because a hung CLI ignores Stop and would hold the queue.
- A `t3_watch` deadline wakes the agent ("passed its deadline") instead of closing silently.
- A restart that stops a monitor wakes the thread like awaited work, through the existing restart
  continuation. A monitor the agent left watching a dev server costs a turn on each server update
  too; that is the price of never losing a monitor that waited on CI.
- Web shows each wait's times in the sidebar hover card, the background line above the composer,
  and its Details dialog. Mobile shows the next check-in in the floating status and the times in the
  background work sheet.

## Implementation

- `packages/shared/src/orchestrationV2PendingBackgroundWork.ts`: `derivePendingBackgroundWork`
  takes `watches`, fills `startedAt`, and `threadWaitCheckIn` is the one check-in rule over a thread
  shell. The server watchdog uses it, and the client shell presenter turns it into
  `waitCheckInAt`, which every surface reads.
- `apps/server/src/watches/WaitWatchdog.ts` sweeps every minute after server activation. It reads
  `getShellSnapshot({ unsettledOnly: true })`, so it sees exactly the waits clients show, and reads
  run activity from the turn item projection. Command ids derive from the thread and the quiet time,
  or from the stalled run, so a repeated sweep or a restart hits the orchestrator's receipts.
- Restart wakes use `wakesAfterRestart` in `RestartBackgroundNote.ts`; `isAwaitedWork` keeps
  upstream's meaning for run outcomes.

## Upstream hooks

- `packages/contracts/src/orchestrationV2.ts`: `startedAt` and `expectedBy` on pending tasks.
- `apps/server/src/orchestration-v2/ProjectionStore.ts`: `pendingBackgroundDataByThreadId` reads open
  `agent_watches` rows and every shell, settlement and awareness read passes them on;
  `may_be_live` counts an open watch.
- `apps/server/src/orchestration-v2/RestartContinuation.ts`: uses `wakesAfterRestart`. The
  `runtimeLayer.test.ts` restart table expects a lost unmarked monitor to continue, where upstream
  (#24610) expects it not to.
- `apps/server/src/server.ts`: provides `WaitWatchdog.layer`.
- Client presentation in `packages/client-runtime/src/state/models.ts` (`waitCheckInAt`) and
  `threadExecution.ts`, and the web and mobile components named above. The web chat view takes
  `t3_watch` waits from the shell, since its thread detail projection has no watches.

## Removal

Drop the check-in and stall rules when upstream wakes quiet waiting threads and recovers runs that
stop making progress. Drop the restart rule when upstream wakes threads for stopped monitors. Keep
the timing fields if upstream shows when a wait began.
