# Worlds

## Fork requirement

BuildlinX and Schnau work spans hundreds of repositories, and agents need all of them at one
path, as today's `~/Buildlinx` umbrella gives them, on any machine and without two threads sharing
a checkout ([#191](https://git.schnau.dev/schnau/t3code/issues/191), decisions 1, 2, 7, 8 and 9).
The worldfs daemon ([worldfs](worldfs.md)) serves the repositories and checks them out per thread;
agent-exec runs each thread in its own namespace. This patch is T3's side: world projects, a thread
world per thread, Claude's checkout hook, the thread's world state, and teardown. Upstream has no
notion of any of it.

## Behavior

- **Settings.** `worlds` maps a world's cache name to `{title, path, layout}`. Nothing is
  hardcoded, so infra declares the worlds per host. The daemon's socket is `WORLDFS_SOCKET` or
  agent-exec's default, the same rule agent-exec follows, so T3 and agent-exec reach one daemon.
- **World projects.** On a Linux host with the launcher, the server keeps one project per
  configured world at `<baseDir>/worlds/<world>`, created with `world` set
  (`world/ThreadWorlds.ts`, `layerBackground`). The project row stores it (migration 114), and
  clients read `project.world`.
- **Thread worlds.** Every launch in a project with `world` set becomes a new `workspace` launch
  (`ThreadLaunchService.launch`), whatever strategy it asked for, so two threads never share a
  world. `create_threads`, which shares the parent's checkout, refuses in a world. `ManagedWorkspaces`
  picks the `world` backend by path, so a world later removed from settings fails clearly instead
  of running on the host. The thread world is `<project root>/<key>`, with the daemon key
  `t3-<sha256(thread id)[:20]>`, so a retried preparation and a resume land on the same
  registration. `agent-exec world` registers it (`world/ThreadWorldLauncher.ts`; the interface is
  #191 comment 5686). From then on the thread world is an agent-exec registration with
  `workspace.visibleRoot` = the world's path, so the existing separate-project routing runs every
  process inside it and shows agents the canonical path.
- **Resume.** Opening a provider session re-runs `agent-exec world` when the thread world has no
  registration, so a thread whose world was torn down gets a fresh one at the same path.
- **Claude's hook.** Claude sessions in a world get a PreToolUse hook for Bash
  (`world/worldHook.ts`). It runs as an SDK callback in T3's server, which is in the host mount
  namespace, so it calls the daemon's `checkout` as the host with the thread's key. It checks out
  the session's cwd and every `cd`/`pushd` target inside the world before the shell starts, and
  turns `cap`, `missing-objects`, `failed` and `unknown-repo` into a readable deny. A daemon that
  is down or doesn't know the thread lets the command run; the daemon's check-out on `cd` covers
  it. Codex has no hook and relies on that.
- **State.** `status` from the daemon becomes `world` on the VCS local status
  (`VcsStatusBroadcaster`) and on `t3_worktree_status`. A refusal whose caller is this server's
  pid is labelled as Claude's Bash hook.
- **Teardown (decision 2).** Every 10 minutes the sweep looks at each thread world. It runs
  `agent-exec retire --remove-checkout` only when its threads are settled, archived or deleted and
  quiet for 6 hours (past a provider session's longest pin), the daemon answers and reports no
  repo `lostOnTeardown`, and no file lies outside the repos (`world/worldTeardown.ts`). It reads the
  threads again just before retiring, in case one resumed meanwhile. agent-exec asks the daemon
  again and keeps everything on a refusal. Explicit deletion goes through
  `ManagedWorkspaces.removeWorktree`, which retires the same way; an unregistered thread world is
  deleted only when it holds no files at all.

## Clients

- Web: `ThreadWorldPanel` in the thread details card; the Version Control row hides for world
  projects and thread worlds, whose roots are no repository.
- Mobile: the thread header's git menu becomes a World menu for a thread world.
- Both offer no workspace choice for a world project (`managedWorkspacesForProject` returns null,
  and the composers' `canChooseWorkspace` is false).

## Upstream touch points

- contracts: `world.ts` (fork-only), `world` on project shells, `project.created` and VCS local
  status, `worlds` in settings and the patch, `world` on `WorktreeMcpStatusResult`.
- server: `orchestration-v2/ThreadLaunchService.ts` (one normalization), `ProviderSessionManager.ts`
  (one `ensure` before the workspace check), `Adapters/ClaudeAdapterV2.ts` (the PreToolUse
  matcher), `vcs/VcsStatusBroadcaster.ts`, `ProjectStore.ts`, `ProjectCommands.ts`,
  `ProjectService.ts`, `mcp/WorktreeMcpService.ts`, `server.ts`.
- web `ThreadDetailsPanel.tsx`, `ChatView.tsx`; mobile `ThreadGitControls.tsx`,
  `new-task-flow-provider.tsx`; client-runtime `state/workspaces.ts`.

## What this does not replace yet

The BuildlinX and Schnau worlds run next to `~/Buildlinx` and the other umbrella projects until
Hauke switches (decision 5), and nothing has moved to worlds yet. So agent-exec's directory
projects, the guarded directory copy in [Workspaces](workspaces.md) and isolated workspaces all
keep callers, and this patch removes none of them. [worldfs](worldfs.md) lists what goes once
the switch is done.

## Removal

Remove this with [worldfs](worldfs.md): when upstream ships lazy multi-repository workspaces, or
when fleet worlds are retired.
