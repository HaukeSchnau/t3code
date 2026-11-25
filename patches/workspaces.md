# Workspaces

Upstream creates new workspaces only as Git worktrees. This fork also creates them for jj
repositories and plain directories, as folders on the host. A launch can opt into an isolated
agent-exec runtime instead, on Linux hosts that set `T3CODE_EXECUTION_LAUNCHER`. Upstream would
run `git worktree add` inside a colocated jj repository, cannot start a new workspace for a
project without Git, and has no notion of an isolated runtime.

Plain Git projects follow upstream on every host and client: upstream's workspace pickers
(including the previous worktree), the "Select a base branch" guard, and upstream's
worktree creation for new threads, MCP launches and handoffs.

## Model

A workspace is a directory bound to threads through `worktreePath`, exactly like an upstream
worktree. Several threads share one through `existing_worktree`. There is no workspace table and
no migration. The kind, the jj workspace name, and the isolated profile are read back from the
directory and the agent-exec registration when they are needed. Migration 35's
`projection_thread_workspace_roots` stays only so new names never reuse a path an old workspace
held.

The server picks the backend from the project and the launch (`workspace/ManagedWorkspaces.ts`):

1. Upstream's Git worktree when the nearest repository marker is `.git`, on every host. A Git
   launch that asks for isolation fails instead of silently getting a worktree. A plain directory
   gets upstream's task folder instead of a copy when upstream's planner (`TaskFolders.plan`)
   returns a plan for it, which it does when the folder tracks Git folders or has a
   `worktreeLayout` command. The launch's `repositories` choice goes to the planner, which fails
   the launch when it refuses that choice. `ManagedWorkspaces.launchBackendFor` makes this decision
   for launches, their preflight and `t3_worktree_handoff`, so they apply the same rules. It
   returns the plan it read, and each phase works from that one plan. The preflight and the
   background preparation are separate phases with separate plans, so if the last tracked
   repository disappears between them, the preflight can pass a task folder that preparation
   then builds as a copy. Neither phase ever mixes two plans. A jj
   project's tracked folders do not change its backend, and `isolated: true` or a separate
   project still gets rule 2's isolated runtime.
2. An isolated runtime for a jj or directory project when the launch sets `isolated: true`. It
   needs a Linux host with the launcher and forks through `agent-exec fork`, with Familiar as the
   default profile. Deletion retires the runtime with `--remove-checkout`, which also removes the
   workspace's private home and state. It exists for clean-room experiments, where the agent
   should not see other projects; agents and users choose it explicitly. A project whose root is
   itself registered with agent-exec (a separate project) keeps every new workspace isolated, as
   its own threads are.
3. A jj workspace (`jj workspace add`, shared store) when the marker is `.jj`. Colocated
   repositories count as jj and get colocated workspaces (`--colocate`), so jj creates the Git
   worktree; T3 never runs `git worktree` there.
4. A guarded directory copy otherwise. It keeps the old size limit
   (`T3CODE_DIRECTORY_COPY_MAX_BYTES`, 5 GiB), free-space and sensitive-root checks, bounded
   APFS and BTRFS clones, and refuses a full-copy fallback the full-copy checks would reject.

Earlier versions isolated every new jj and directory workspace on launcher hosts, and before that
Git projects too. Those workspaces keep their registrations, so their threads still run inside
them and deletion still retires them.

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

Upstream's `checkpoint.rollback` with `restoreFiles: false` accepts `missing` and `error`
checkpoints, so "Edit from here" rewinds the conversation in folders without Git. Upstream's web client now offers
that rewind and decides when "Revert files too" applies (`findRevertCheckpoint`,
`rewindFileRestore`). Upstream offers file restore only in a worktree; the revert dialog in
`chat/ChatOverlayHosts.tsx` also offers it in a jj working copy (`jjWorkingCopy`), which jj
workspaces get through thread-scoped file restore in the jj driver (see `jujutsu.md`).

## Contract

- `OrchestrationV2ThreadLaunchWorkspaceStrategy` gains `{ type: "workspace", baseRef?,
  startFromOrigin?, isolated?, profile? }` (`packages/contracts/src/workspace.ts`). `profile`
  applies only with `isolated`; clients before the opt-in always sent it, so it cannot imply
  isolation. The server also routes a
  plain `worktree` launch on a jj or directory project to the same backends, so upstream clients
  and agents never create Git worktrees there. A `workspace` launch on a Git project becomes
  upstream's `worktree` launch from the given or current branch. On a plain folder that gets a
  task folder it starts from `HEAD`, so each repository starts from its own default branch.
- `ExecutionEnvironmentCapabilities.managedWorkspaces = { isolated }` tells clients to offer
  managed workspaces, and whether to offer **New isolated workspace** with its profile choice.
  Web and mobile keep that choice in memory for the next send only. The capability is per server; clients apply
  it per project through `managedWorkspacesForProject` (client-runtime `state/workspaces.ts`),
  which offers them only once the status confirms a jj checkout (`kind: "jj"`) or no repository
  (`isRepo: false`). While the status is unknown (cold start, offline), clients use upstream's
  flow and its base-branch guard; web remembers "no repository" per checkout, so directory
  projects don't flash.
- Scheduled task forms on web and mobile have no managed workspace choice. They show a saved
  `workspace` strategy as a new worktree and save it back unchanged, `isolated` and `profile`
  included, unless the user changes the workspace fields. A changed base keeps the strategy's
  type and isolation. The mapping is fork-owned client-runtime `scheduledTaskWorkspace.ts`.

## Upstream hooks

- `orchestration-v2/ThreadLaunchService.ts`: the internal strategy type includes `workspace`, and
  `PreparationInput` carries the launch `title` for the workspace name (a retried preparation uses
  the thread's title). `prepareInBackground` resolves the strategy, tracks a `workspace` like a
  worktree, creates the managed workspace in its own block, and discards it when a cancelled or
  failed preparation abandons it. `schedulePreparation` races a `workspace` preparation against
  run cancellation, as it does for worktrees. `checkWorktreeBase` asks `launchBackendFor` before
  upstream's Git checks, so a `worktree` request that gets a managed workspace is not refused as
  "not a Git repository".
- shared `orchestrationV2ThreadError.ts`: `preparesWorktree` treats an unfinished `workspace`
  preparation like a worktree's. The orchestrator's queue holds and the side-chat guard on server,
  web and mobile use it, so neither queued messages nor side chats start in the project checkout.
- `ws.ts`: `vcs.removeWorktree` goes through `ManagedWorkspaces.removeWorktree`.
- `server.ts`: provides the layer. `environment/ServerEnvironment.ts`: advertises the capability.
- `project/ProjectSetupScriptRunner.ts`: visible setup paths.
- `mcp/WorktreeMcpService.ts`: `t3_worktree_handoff` delegates to `mcp/ManagedWorkspaceHandoff.ts`
  when `launchBackendFor` picks a managed backend. `t3_thread_launch` takes the new strategy through the schema. The
  `workspace` sentences in `mcp/toolkits/project/tools.ts` and `mcp/toolkits/worktree/tools.ts`
  describe it to agents.
- `packages/provider-core/src/server/orchestrationInstructions.ts`: one sentence in the
  `t3_thread_launch` bullet points agents at `{"type":"workspace"}` and at `isolated:true` for
  clean rooms the user asks for.
- `jj/JjTurnHooks.ts`: a fork gets its own jj workspace unless its source is an isolated one.
- client-runtime `operations/commands.ts`: `bootstrap.prepareWorkspace`. Its conversation-only
  revert check is upstream's since #18379. `state/workspaces.ts` is fork-owned.
- web `ChatView.tsx` computes the per-project capability once and passes it to `BranchToolbar`
  and `useComposerSend`; mobile `new-task-flow-provider.tsx` exposes it as
  `flow.managedWorkspaces`. In the composer, `ManagedWorkspaceSelector` takes the place of
  upstream's workspace menu. Once a thread starts, the composer shows its workspace only in the
  details card, so `BranchToolbar`'s panel keeps the workspace row (`namesWorkspace`) for a thread
  in a workspace folder without Git.
- web `BranchToolbar.tsx`, `ChatView.tsx`, `ChatView.logic.ts` (`planComposerTurn` returns
  `shouldCreateWorktree`), `chat/useComposerSend.ts` (the `prepareWorkspace` bootstrap),
  `settings/scheduledTasksSettings.logic.ts`, `settings/ScheduledTasksSettings.tsx`; fork-owned `ManagedWorkspaceSelector.tsx` and
  `lib/managedWorkspaces.ts`.
- mobile `Stack.tsx` (the `NewTaskWorkspace` root route), `layout/workspace-overlay-routes.ts`,
  `NewTaskDraftScreen.tsx`, `new-task-flow-provider.tsx`,
  `NewTaskContextPickerScreens.tsx` (exports `PickerSurface` and `ToggleRow`),
  `lib/projectThreadStartTurn.ts`, `state/thread-outbox-model.ts`, `state/threadOutboxDelivery.ts`,
  `settings/scheduledTaskDraft.ts`, `settings/SettingsScheduledTasksRouteScreen.tsx`; fork-owned `NewTaskWorkspacePickerRouteScreen.tsx` and
  `managed-workspaces.ts`.
- Test harnesses of `ThreadLaunchService` and `WorktreeMcpService` provide a mock layer.

## Not carried over

- The CLI flags `--workspace-profile` and `--workspace ID`. Upstream's `t3 thread start` has only
  `--worktree`, which the server turns into a managed workspace where it would for an agent.
- jj workspaces no thread ever used are not listed in the pickers.
- Mobile keeps the profile choice for the app session only.
- Isolation through `t3_worktree_handoff`, multi-model sends, and `delegate_task`. They create
  host workspaces; `delegate_task`'s `isolation: "worktree"` names a Git checkout, not a clean
  room.
- Multi-model sends always request Git worktrees, as upstream. On jj projects the server routes
  them into managed workspaces.
- Isolated workspaces for Git projects. Git projects get upstream's worktrees on every host, so
  their agents run on the host like upstream's.
- Upstream's retried preparation reuses a Git worktree the first attempt recorded. A managed
  workspace has no branch, so a retry after its workspace was recorded creates a new one and
  leaves the first in place.

## Removal

Drop this patch when upstream creates workspaces for jj repositories and non-Git projects, and
offers a pluggable execution backend that agent-exec can implement.
