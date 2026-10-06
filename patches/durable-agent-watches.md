# Durable agent watches

## Fork requirement

An agent can end its turn and still be woken when something happens: a thread it started finishes,
or a long-running command prints output or exits. T3 Code does the waiting, so it spends no model
tokens and survives server restarts. Upstream has `t3_thread_wait`, which holds the turn open and
polls, and provider-native monitors such as Claude Code's Monitor tool, which end with the provider
process. Neither keeps watching once the turn or the process is gone.

Watchers never call a model. The v1 fork's `policy: model` option, which asked a text-generation
model whether a batch was worth a wake-up, is gone on purpose.

## Behavior

- The `t3-code` MCP server exposes `t3_watch`, `t3_watch_list` and `t3_watch_cancel`. They need the
  `orchestration` capability. Creating and cancelling also need a live calling run, like the other
  mutating thread tools. A watch belongs to the thread that created it.
- A thread source fires once when a run ends as completed, failed, interrupted, cancelled or rolled
  back. Without a `runId` it follows the active run, then the next queued run, then the latest run,
  then the thread's first run. A run that already ended fires during `t3_watch`, which covers a
  thread launched with `t3_thread_launch` that finished before the watch arrived. The target may be
  in any project, so lookups use the unscoped `ThreadManagementService` methods. Deleting the target
  fires the watch too.
- A command source runs `/bin/sh -c <command>` (the platform shell on Windows) in the watcher's
  worktree or project root. It spawns through `ProviderProcessSpawner`, so a registered separate
  project runs inside `agent-exec` and production commands get their own systemd scope. Stdout and
  stderr lines are batched for 200 ms, up to 1,024 lines and 3,000 characters per batch. A batch
  identical to the previous one is skipped, and a token bucket (ten bursts, one more every two
  seconds) fails the watch after 30 seconds of sustained overload. Exit closes the watch with one
  last wake-up carrying the exit status. Command watches run without approval, so the watching
  thread must be full-access.
- An optional deadline, an ISO date-time or a duration such as `30 minutes`, closes the watch
  without a wake-up. Cancelling, or archiving or deleting the watching thread, closes it the same
  way and stops the command.
- Each wake-up is one `message.dispatch` into the watching thread with
  `notification.source.kind: "monitor"`, `createdBy: "agent"`, `creationSource: "server"` and
  `dispatchMode: queue_after_active`. It starts an idle thread and queues behind an active turn.

## Implementation

`apps/server/src/watches/AgentWatches.ts` owns the service and `WatchRuntime.ts` the batching, the
gates, the shutdown guard and the command runner. The MCP toolkit lives in
`apps/server/src/mcp/toolkits/watch/`.

Watches are rows in `agent_watches` (fork migration 80). A row is `open`, `closing` or `closed`.
`closing` stores the final wake-up before it is sent, so a restart delivers it instead of running
the command again. Command and message ids derive from the watch id and an event key: `fired`,
`<generation>:<sequence>` for output and `<generation>:exit`. The generation increments on every
spawn, so output from a restarted command never reuses an id, and a replayed final wake-up hits the
orchestrator's command receipt instead of adding a second message.

Startup runs after server activation. It delivers pending `closing` rows, closes watches whose
deadline passed or whose thread is gone, fires thread watches whose run ended while the server was
down, and respawns command watches. A thread watch reads the target's event sequence before its
state and then follows `streamStoredEventsFrom`, so no run update falls between the two. Archive and
delete are observed on the shared domain event stream, and every delivery checks the watching
thread first.

Server shutdown interrupts watch fibers without closing their rows. A SIGTERM/SIGINT listener marks
shutdown first, because a service manager can kill the command before the server interrupts it, and
that exit must not close the watch.

No client changes are needed. Web and mobile render `monitor` notifications as a work row with an
eye icon and the summary; the web inspector also shows the output in `detail`. The feature works the
same for every provider with access to the `t3-code` MCP server.

## Differences from the v1 fork

- Wake-ups queue behind an active turn instead of steering it. The v2 orchestrator accepts a
  `notification` only as a server or provider message with `queue_after_active`, and
  `dispatchSteerIntoRun` drops the field. Steering would need hooks in `Orchestrator.ts`
  (validation, the mailbox steer routing, the steered message) and in `EffectWorker.ts` (the
  steer follow-up redispatch), on code upstream changes often.
- WebSocket and argv sources, the Work panel listing, the lifecycle row per watch and the model
  policy are not ported. The CLI commands were replaced by the MCP tools.

## Upstream hooks

- `apps/server/src/persistence/Migrations.ts`: imports and registers migration 80.
- `apps/server/src/mcp/McpHttpServer.ts`: imports `WatchToolkitRegistrationLive` and merges it into
  the MCP layer.
- `apps/server/src/server.ts`: provides `AgentWatches.layer`, with `ProviderProcessSpawnerLayerLive`,
  to the runtime.

## Removal

Drop this patch when upstream has a server-owned watch that survives restarts, starts an idle
thread without a model call, follows threads in any project, and runs commands through project
execution. Keep migration 80 in the registry when removing the code; a later migration can drop the
table.
