# Scheduled task failure tracking

Upstream scheduled tasks report a run as succeeded once its thread is launched and tell nobody when
runs fail. An agent asked to check one upcoming run scheduled a daily task that launched a new
thread each day. Every run failed during workspace preparation, the task still showed `succeeded`,
and the agent that created it never heard about it, so it failed for a week.

Upstream now ships one-time tasks (`{type: "once", runAt}`, #28104), so the fork's own `once`
trigger is gone. This patch still catches a workspace that can never be copied when the task is
saved, counts preparation failures as failed runs, pauses a task after repeated failures, and tells
the agent thread that created a task when its runs fail.

## Requirements

- Fork builds stored one-time tasks as `{type: "once", at}`. Fork migration 109 rewrites them to
  upstream's `runAt`, so they still decode. A finished one-time task stays enabled with no next run,
  as upstream shows it.
- Saving a task whose runs launch into a `worktree` or `workspace` fails when the project is a
  plain directory that is missing or unreadable, too big to copy, or one a workspace may not copy, such as the
  home directory. The MCP `schedule_task` tool hard-codes `worktree` for tasks not
  bound to a thread, so the error tells the caller to run the task in the project folder or an
  existing thread. The check runs only when the task is new or its project or workspace strategy
  changed, because `du` over a large project is slow.
- A run that launches a new thread is recorded as succeeded at launch, because due tasks run one
  at a time and preparation can take minutes. `ThreadLaunchInput.preparation` is a `Deferred` that
  `ThreadLaunchService` completes when the background preparation ends. The scheduler watches it in
  its own scope. A cancelled preparation fails it too. A preparation that ends after a later run
  started still updates the failure count, so the count follows the order preparations end in. It
  rewrites the run's record to failed only while that run is the latest. A task deleted and
  recreated under the same id ignores the old task's preparations. Preparation that resumes after
  a server restart has no `Deferred`, so its outcome is not recorded.
- `scheduled_tasks.consecutive_failures` (fork migration 99) counts failed runs. A launch or send
  failure, or a failed preparation, adds one; a bound run's send or a launched run's finished
  preparation resets it. At `SCHEDULED_TASK_MAX_CONSECUTIVE_FAILURES` (3) the task pauses with its
  last error kept. Resuming it, from Settings or `schedule_task`, resets the count. Settings shows
  "Paused after 3 failed runs in a row", and MCP task summaries carry `lastRunError` and
  `consecutiveFailures`.
- `scheduled_tasks.creator_thread_id` (fork migration 99) records the thread whose agent created
  the task through `schedule_task`; edits keep it. Each failed run queues a `system` notification
  into that thread with the error, the failure count, whether the task is paused, and how to fix
  it with `schedule_task` or `delete_scheduled_task`; a one-time task with no run left gets a new
  `runAt` instead of a resume. The notice is skipped when the creator is the
  task's bound thread, when that thread is deleted or archived, and for tasks created in Settings.

## Upstream hooks

- `apps/server/src/persistence/Migrations.ts` registers migrations 99 and 109.
- `apps/server/src/orchestration-v2/ThreadLaunchService.ts` completes `preparation` in
  `schedulePreparation`, and at the end of `launch` when it schedules nothing.
- `ScheduledTaskService.ts` records a run in upstream's transaction and wakes the creator and the
  preparation watch only after it commits, so no dispatch waits on SQLite's writer lock.

Remove this when upstream checks a task's workspace when it is saved and reports workspace
preparation failures back to the task and its creator. Keep migrations 99 and 109 in the registry
when removing the code.
