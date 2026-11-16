# Declared scheduled tasks

## Fork requirement

The maintainer's hosts need scheduled tasks that the host's configuration (`~/infra`) owns, such
as the nightly follow-up gardener on each follow-up home. Upstream scheduled tasks come only from
users and agents, through Settings and MCP, and live only in the database, so a deploy cannot
declare, change or remove one.

## Behavior

- The host writes `<state dir>/declared-scheduled-tasks.json` (`~/.t3/userdata` in production):
  `{"tasks": {"<key>": {"title", "prompt", "schedule", "project"?, "model"?}}}`. A schedule is a
  time of day or an interval; webhook tasks need a token and a secret that a host file should not
  carry. `project` is a project's absolute path, and without one the task runs in No project.
  `model` defaults to the project's default model.
- `DeclaredScheduledTasks.ts` reads the file on every scheduler tick (5 s) and applies it when its
  content or the settings changed. It adds, updates and removes the tasks with id `declared:<key>`
  and never touches others. It re-reads the file instead of taking it from the unit's environment
  because a deploy defers T3's restart until agents are idle, for up to a day.
- A missing file declares nothing, so removing a host's last declaration removes its task. An
  unreadable or invalid file changes nothing and logs an error. A task that cannot apply (unknown
  project, no model) keeps its stored version while the others apply. A failed apply runs again
  after five minutes or when the file or settings change.
- The host owns the definition. `ScheduledTaskService.upsert` and `delete` refuse a declared id
  unless the declarations call them, so Settings, MCP and the RPCs all get the same refusal. Run now,
  pause and resume still work, and an apply keeps the paused state, so a task that paused itself
  after failed runs can be resumed.
- Clients read `ScheduledTask.declared`: they hide Edit and Delete and mark the task. MCP summaries
  carry `declaredBy: "host configuration"`, and `schedule_task` with only `enabled` pauses or
  resumes a declared task.
- Dev servers keep their own state directory, so they never pick up a host's declarations.

## Upstream touch points

- `packages/contracts/src/scheduledTask.ts` (`declared`) and `orchestratorMcp.ts` (`declaredBy`).
- `apps/server/src/scheduledTasks/ScheduledTaskService.ts` (declared ids, the refusal, the flag on
  decode), `mcp/OrchestratorMcpService.ts` (summary and `enabled`-only updates),
  `mcp/toolkits/orchestrator/tools.ts` (the `schedule_task` description), `server.ts` (layer
  wiring).
- Web `ScheduledTasksSettings.tsx` and mobile `SettingsScheduledTasksRouteScreen.tsx`.

## Removal

Remove when upstream lets a host's configuration declare scheduled tasks that a running server
picks up. Stored `declared:` tasks then become ordinary tasks that users can edit or delete.
