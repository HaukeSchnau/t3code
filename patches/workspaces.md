# Workspaces

Upstream creates new workspaces only as Git worktrees. This fork also creates them for jj
repositories, for plain directories, and as isolated agent-exec runtimes on Linux hosts that set
`T3CODE_EXECUTION_LAUNCHER`. Upstream would run `git worktree add` inside a colocated jj
repository, cannot start a new workspace for a project without Git, and has no notion of an
isolated runtime.

## Model

A workspace is a directory bound to threads through `worktreePath`, exactly like an upstream
worktree. Several threads share one through `existing_worktree`. There is no workspace table and
no migration. The kind, the jj workspace name, and the isolated profile are read back from the
directory and the agent-exec registration when they are needed. Migration 35's
`projection_thread_workspace_roots` stays only so new names never reuse a path an old workspace
held.

The server picks the backend from the project (`workspace/ManagedWorkspaces.ts`):

1. An isolated runtime when the host is Linux and the launcher is configured. Every source kind
   forks through `agent-exec fork`, with Familiar as the default profile and Minimal under
   Advanced. Deletion retires the runtime with `--remove-checkout`.
2. A jj workspace (`jj workspace add`, shared store) when the nearest repository marker is `.jj`.
   Colocated repositories count as jj. `git worktree` never runs there.
3. Upstream's Git worktree when the marker is `.git`.
4. A guarded directory copy otherwise. It keeps the old size limit
   (`T3CODE_DIRECTORY_COPY_MAX_BYTES`, 5 GiB), free-space and sensitive-root checks, bounded
   APFS and BTRFS clones, and refuses a full-copy fallback the full-copy checks would reject.

Managed workspaces live under `<baseDir>/workspaces/<project>/<name>`, the same layout as before
the v2 merge, so threads imported from v1 keep working and their workspaces appear in the pickers.
The name comes once from a generated title (five seconds at most), else the launch title, else
`task-<id>`. Only a live collision adds a suffix, counting existing directories, paths any thread
still names, and jj workspace names. Names never follow later title changes.

Settlement and archiving hide a workspace in the pickers and never delete or merge files.
Explicit deletion through `vcs.removeWorktree` refuses while an unarchived, unsettled thread or a
running thread uses the directory. Upstream's automatic worktree cleanup only touches
`<baseDir>/worktrees`, so it never sees managed workspaces. Cancelling a launch during
preparation removes the workspace it just created, matching upstream's "Work locally" retry.

Setup scripts run in the workspace terminal as upstream does. Inside an isolated workspace,
`T3CODE_PROJECT_ROOT` and `T3CODE_WORKTREE_PATH` name the workspace's visible root, because the
source checkout is not mounted there.

`checkpoint.rollback` with `restoreFiles: false` accepts `missing` and `error` checkpoints, so
"Edit from here" rewinds the conversation in jj workspaces and folders without Git. Files cannot
be restored there, because v2 checkpoints are Git refs written through the Git driver and a
secondary jj workspace has no `.git`. Colocated default jj workspaces keep normal Git checkpoints.

## Contract

- `OrchestrationV2ThreadLaunchWorkspaceStrategy` gains `{ type: "workspace", baseRef?,
startFromOrigin?, profile? }` (`packages/contracts/src/workspace.ts`). The server also routes a
  plain `worktree` launch on a jj, directory or isolated project to the same backends, so
  upstream clients and agents never create Git worktrees there.
- `ExecutionEnvironmentCapabilities.managedWorkspaces = { isolated }` tells clients to offer
  workspaces without Git and to show the profile choice.

## Upstream hooks

- `orchestration-v2/ThreadLaunchService.ts`: the internal strategy type includes `workspace`;
  `prepareInBackground` resolves the strategy, creates a managed workspace in its own block, and
  discards it on cancellation.
- `orchestration-v2/Orchestrator.ts`, `CheckpointRollbackService.ts`: conversation-only rollback
  without a ready checkpoint.
- `ws.ts`: `vcs.removeWorktree` goes through `ManagedWorkspaces.removeWorktree`.
- `server.ts`: provides the layer. `environment/ServerEnvironment.ts`: advertises the capability.
- `project/ProjectSetupScriptRunner.ts`: visible setup paths.
- `mcp/WorktreeMcpService.ts`: `t3_worktree_handoff` delegates to `mcp/ManagedWorkspaceHandoff.ts`
  for non-Git backends. `t3_thread_launch` takes the new strategy through the schema.
- client-runtime `operations/commands.ts`: `bootstrap.prepareWorkspace` and the conversation-only
  revert. `state/workspaces.ts` is fork-owned.
- web `BranchToolbar.tsx`, `ChatView.tsx`, `session-logic.ts`,
  `settings/scheduledTasksSettings.logic.ts`; fork-owned `ManagedWorkspaceSelector.tsx` and
  `lib/managedWorkspaces.ts`.
- mobile `Stack.tsx`, `NewTaskDraftScreen.tsx`, `new-task-flow-provider.tsx`,
  `NewTaskContextPickerScreens.tsx` (exports its rows), `lib/projectThreadStartTurn.ts`,
  `state/thread-outbox-model.ts`, `state/use-thread-outbox-drain.ts`,
  `settings/scheduledTaskDraft.ts`; fork-owned `NewTaskWorkspacePickerRouteScreen.tsx` and
  `managed-workspaces.ts`.
- Test harnesses of `ThreadLaunchService` and `WorktreeMcpService` provide a mock layer.

## Not carried over

- The CLI flags `t3 thread create --worktree --workspace-profile` and `--workspace ID`; v2 has no
  `t3 thread` command.
- File checkpoints and the diff panel inside secondary jj workspaces (see above).
- jj workspaces no thread ever used are not listed in the pickers.
- Mobile keeps the profile choice for the app session only.
- Multi-model sends stay Git-only, as upstream; on isolated hosts the server still routes them
  into isolated workspaces with the Familiar profile.

## Removal

Drop this patch when upstream creates workspaces for jj repositories and non-Git projects, and
offers a pluggable execution backend that agent-exec can implement. jj-aware Git checkpoints
(`GIT_DIR` on the shared store with the jj workspace as work tree) would close the checkpoint gap.
