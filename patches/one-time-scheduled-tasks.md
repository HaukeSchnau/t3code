# One-time scheduled tasks

Scheduled tasks gain a `{type: "once", at}` trigger. The task runs at `at` and then pauses itself,
whether the run succeeded or failed. Upstream has only repeating triggers (`interval`,
`fixed_time`, `webhook`). Without a one-time trigger, agents scheduled one-off checks as daily
tasks and told the run to delete its own task. A run that failed before the agent started never
got to that step, so the task kept firing and failing every day.

Saving a task whose runs launch into a `worktree` or `workspace` now fails when the project is a
plain directory that is too big to copy. Before, the save succeeded and every run failed during
workspace preparation. The MCP `schedule_task` tool hard-codes `worktree` for tasks not bound to a
thread, so the error tells the caller to run the task in the project folder or an existing thread.

## Requirements

- `nextScheduledRunAt` returns `at` only while it is in the future. Completion, stuck-run release
  and restart recovery pause a `once` task that has no next run, so Settings shows it as done.
- Saving an enabled `once` task, or switching one on, fails when `at` is in the past.
- The copy check runs on save only when the task is new or its project or workspace strategy
  changed, because `du` over a large project is slow.
- Web and mobile Settings offer a "Once" schedule. Mobile uses separate date and time pickers
  because Android's picker has no combined mode.

Remove this when upstream ships a one-time trigger and checks a task's workspace when it is saved.
