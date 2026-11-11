# Jujutsu

Upstream only has a Git VCS driver. `VcsDriverKind` lists `jj`, but a jj repository is either
treated as plain Git (colocated) or as no repository at all, so checkpoints, turn diffs and status
are missing or Git-shaped there. This fork makes jj a first-class driver and adds jj-native turn
handling, because the maintainer and their agents work in jj repositories.

## Requirements

- A repository whose nearest marker is `.jj` is jj, including colocated ones
  (`vcs/RepositoryMarker.ts`, `VcsDriverRegistry`). A colocated repository stays
  `gitCompatible`, so every server Git workflow, PR lookup and review diff keeps working there.
  The web branch toolbar and thread details panel show `JjStackControl` in place of upstream's Git
  actions and branch selector.
- jj 0.46 or newer; older versions fall back to Git in colocated repositories.
- Checkpoints are commit ids of `@` after a snapshot, recorded under `.jj/t3/checkpoints`
  (`vcs/JjVcsDriver.ts`). Diffs run Git against jj's backing store, so output matches the Git
  driver. Later checkpoints are kept after a rollback, so it can be undone. Turn diffs keep every
  changed path: upstream's Git driver drops paths a pull or rebase brought in
  (`listAuthoredPaths`), and the jj driver returns null there because telling them apart would
  need jj's operation log.
- Every turn ends in its own change (`jj/JjTurnService.ts`, called from
  `CheckpointCaptureService` before the checkpoint, failed runs included). A turn that committed
  its own work leaves nothing to seal. A `@` the agent described stays as it is, unrenamed,
  unsplit and without a new change on top, because the agent may keep working in it. Seals get
  a provisional message at once and the commit writer's message later, so finalization never
  waits on a model.
- Several threads may share a checkout. Files are attributed per turn from provider-reported paths
  and from time slices with one running turn (`jj/JjWorkingCopyState.ts`). Ambiguous files stay
  in `@` until assigned (`vcs.jj.assignPaths`).
- Commits carry `T3-Thread` and `T3-Turn` trailers. Seals write them; providers with a process per
  thread get a per-thread `JJ_CONFIG` layer so the agent's own jj commands add them
  (`jj/JjThreadLayer.ts`, provided to adapters through `ProviderThreadEnvironment`). On launcher hosts
  agent-exec owns the agent's environment and home, so those agents only get `JJ_OP_USERNAME`,
  and the seal tags their unpushed commits afterwards. Projects can turn trailers off
  (`jjCommitTrailers`) and strip them from pushes to listed remotes (`jjStripTrailersRemotes`).
- Reverting files in a jj working copy abandons the thread's later changes and restores its files,
  after other threads' turns in that checkout go idle (`VcsTurnHooks`,
  `CheckpointRestoreSafety`, `CheckpointRollbackService`). Shared checkouts may revert. Only
  changes known to be the thread's are abandoned: its seals, its agent's commits from turns no
  other thread shared, and changes with its trailer. Anything else, such as a branch the agent
  merged or a sibling's work with trailers off, stays. A change of the thread's that also holds
  another thread's files, or that another workspace builds on, stays too, and only the thread's
  own paths in it are restored. Revert refuses before the conversation rewinds when jj cannot
  restore the checkpoint, as with turns from before jj support.
- A fork gets its own workspace at the parent's `@-` while `@` is empty, and shares the parent's
  directory otherwise. A workspace whose `@` descends from a rewritten change goes stale, and
  `jj workspace update-stale` moves unsnapshotted edits into a divergent copy of `@`. So T3 skips
  its own describes of changes another workspace builds on, and moves that copy's files back into
  `@` after it updates a stale workspace (`vcs/JjCli.ts`). An agent that runs `update-stale` itself
  still leaves its edits in the divergent copy.
- A side chat (upstream #26901) works in its parent's checkout and sees its live edits, so it gets
  no workspace of its own, no turn-start hook and no seal. Sealing would commit the parent's edits
  as the side chat's turn. `runtimeLayer.test.ts` ("a side chat keeps working in its parent's
  checkout") covers the workspace.
- Status reads never snapshot (`--ignore-working-copy`); the jj block on the status payload holds
  the stack from `trunk()` to `@` (`jj/JjStatusReader.ts`).
- jj actions run through one service for RPC (`vcs.jj.runAction`) and MCP (`t3_jj_action`,
  `t3_jj_status`): `jj/JjWorkflow.ts`. Every action records its jj operations so "undo" reverts
  exactly what T3 did. Actions that rewrite files refuse while a turn runs in the working copy.
- T3 always pins `ui.log-word-wrap=false`, because wrapped template output breaks parsing.

## Upstream hooks

- `vcs/VcsDriverRegistry.ts` (jj driver, `gitCompatible`), `git/GitWorkflowService.ts` and
  `review/ReviewService.ts` (accept Git-compatible handles). Upstream dropped the Git-only guards
  in `GitWorkflowService.ts` because its registry only detects Git; the fork keeps them as
  `gitCompatible` checks, so a jj repository without a Git worktree still fails cleanly.
- `checkpointing/CheckpointStore.ts` (`isCheckpointable`), `orchestration-v2/CheckpointService.ts`.
- `orchestration-v2/RunExecutionService.ts` (turn start hook; failed runs enqueue a capture),
  `CheckpointCaptureService.ts` (seal before capture; failed runs keep their status),
  `CheckpointRestoreSafety.ts`, `CheckpointRollbackService.ts`, and `Orchestrator.ts` (a fork's
  own workspace and its merge-back), all through `orchestration-v2/VcsTurnHooks.ts`.
- `mcp/McpHttpServer.ts` registers the jj toolkit (`layerJjToolkit`). Its handlers declare access
  through `McpToolAccess`: status and thread work read as the calling thread, and `t3_jj_action`
  acts as it.
- `vcs/VcsStatusBroadcaster.ts`: every local status read, including the branch picker's
  local-only refresh, goes through the jj reader (`localStatusFor`). For jj without Git the remote
  status is skipped (`remoteStatusFor`) and the current branch is null (`currentBranchFor`),
  because `GitWorkflowService` fails those reads for a checkout that is not Git-compatible.
  `GitWorkflowService.repositoryRoot` reports only Git-compatible checkouts.
- `auth/RpcAuthorization.ts` and `observability/RpcInstrumentation.ts` list the `vcs.jj.*` RPCs.
  Actions and path assignment need `source-control:write`, like upstream's VCS mutations; thread
  work needs `orchestration:read`. `server.ts` builds one `JjCli` for the jj services and the MCP
  toolkit (`layerJj`), and the broadcaster gets its own status reader.
- Provider adapters: complete file paths and command cwd, per-thread environment.
- `textGeneration/commitMessageText.ts` holds helpers moved out of `GitManager`.
- Contracts: `jj.ts`, `kind` and `jj` on the local status, `cwd` on `command_execution`, two
  project settings. Web `JjStackControl`, mobile `JjStackSheet`.
- Web: `ChatView.tsx` reads `kind` from upstream's narrowed `chatGitStatusAtom` (`state/vcs.ts`),
  `BranchToolbar.tsx` takes `jjCwd`, and `chat/ThreadDetailsPanel.tsx` puts `JjStackControl` in
  upstream's Version Control section when any of its rows is visible.
- Mobile: `ThreadGitControls.tsx` puts the stack breadcrumb and push state in upstream's git menu,
  omits the Git quick action for a jj stack, and opens `JjStackSheet` from More.
  `ThreadRouteScreen.tsx` opens the sheet in place of the git inspector.

## Removal

Drop this patch when upstream ships a jj driver with checkpoints and a jj-aware status and
actions surface. The trailer, seal and shared-checkout attribution behavior would need an
upstream equivalent or a smaller fork patch on top.
