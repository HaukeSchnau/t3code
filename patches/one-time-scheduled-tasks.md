# One-time scheduled tasks

Upstream scheduled tasks only repeat, report a run as succeeded once its thread is launched, and
tell nobody when runs fail. An agent asked to check one upcoming run scheduled a daily task that
launched a new thread each day. Every run failed during workspace preparation, the task still
showed `succeeded`, and the agent that created it never heard about it, so it failed for a week.

This patch adds a one-time trigger, catches a workspace that can never be copied when the task is
saved, counts preparation failures as failed runs, pauses a task after repeated failures, and
tells the agent thread that created a task when its runs fail.

## Requirements

- Scheduled tasks gain a `{type: "once", at}` trigger. `nextScheduledRunAt` returns `at` only while
  it is in the future. Completion, stuck-run release and restart recovery pause a `once` task that
  has no next run, so Settings shows it as done. Saving an enabled `once` task, or switching one
  on, fails when `at` is in the past. Web and mobile Settings offer a "Once" schedule. Mobile uses
  separate date and time pickers because Android's picker has no combined mode.
- Saving a task whose runs launch into a `worktree` or `workspace` fails when the project is a
  plain directory that is missing, too big to copy, or one a workspace may not copy, such as the
  home directory. The MCP `schedule_task` tool hard-codes `worktree` for tasks not
  bound to a thread, so the error tells the caller to run the task in the project folder or an
  existing thread. The check runs only when the task is new or its project or workspace strategy
  changed, because `du` over a large project is slow.
- A run that launches a new thread is recorded as succeeded at launch, because due tasks run one
  at a time and preparation can take minutes. `ThreadLaunchInput.preparation` is a `Deferred` that
  `ThreadLaunchService` completes when the background preparation ends. The scheduler watches it in
  its own scope. A failed preparation always counts toward the failure count, even when a later
  run has started since; it rewrites the run's record to failed only while that run is the latest. Preparation
  that resumes after a server restart has no `Deferred`, so its outcome is not recorded.
- `scheduled_tasks.consecutive_failures` (fork migration 99) counts failed runs. A launch or send
  failure, or a failed preparation, adds one; a bound run's send or a launched run's finished
  preparation resets it. At `SCHEDULED_TASK_MAX_CONSECUTIVE_FAILURES` (3) the task pauses with its
  last error kept. Resuming it, from Settings or `schedule_task`, resets the count. Settings shows
  "Paused after 3 failed runs in a row", and MCP task summaries carry `lastRunError` and
  `consecutiveFailures`.
- `scheduled_tasks.creator_thread_id` (fork migration 99) records the thread whose agent created
  the task through `schedule_task`; edits keep it. Each failed run queues a `system` notification
  into that thread with the error, the failure count, whether the task is paused, and how to fix
  it with `schedule_task` or `delete_scheduled_task`. The notice is skipped when the creator is the
  task's bound thread, when that thread is deleted or archived, and for tasks created in Settings.

## Upstream hooks

- `apps/server/src/persistence/Migrations.ts` registers migration 99.
- `apps/server/src/orchestration-v2/ThreadLaunchService.ts` completes `preparation` in
  `schedulePreparation`, and at the end of `launch` when it schedules nothing.

Remove this when upstream ships a one-time trigger, checks a task's workspace when it is saved,
and reports workspace preparation failures back to the task and its creator. Keep migration 99 in
the registry when removing the code.
