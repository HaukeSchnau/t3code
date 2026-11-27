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

- **Settings.** `worlds` maps a world's cache name to `{title, path, repo, mounts}`. Nothing is
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
- **World repo (4d).** A world's `repo` is cloned as each thread world's root, so its
  `AGENTS.md`, `agent-notes/` and `world.json` (the layout) sit at the top of the world and travel
  between machines. Its `.gitignore` keeps everything else out, so git never walks the repos below. Launches bind
  its `.git` read-only: T3 runs git there on the host with the host's keys, so the thread must not
  plant hooks, config or filters.
  At the end of every turn (`CheckpointCaptureService`, after the jj seal) T3 runs `agent-exec
  world-notes` in the background, one at a time per thread world: commit, merge the remote's with
  git's union driver for notes, check every file the push would send, push that exact commit. A refused or failed push keeps
  the commits; the thread's world state lists the world repo with its changes, unpushed commits and
  the last error, and teardown waits for them. Notes need no T3 UI of their own.
- **Mounts (4d).** Each of a world's `mounts` is bound read-only at the same path in every launch,
  such as BuildlinX's store of material that must never enter git (infra's
  `modules/features/worlds/store.nix`).
- **Resume.** Opening a provider session re-runs `agent-exec world` when the thread world has no
  registration, so a thread whose world was torn down gets a fresh one at the same path.
- **Claude's hook.** Claude sessions in a world get a PreToolUse hook for Bash
  (`world/worldHook.ts`). It runs as an SDK callback in T3's server, which is in the host mount
  namespace, so it calls the daemon's `checkout` as the host with the thread's key. It checks out
  the session's cwd and every `cd`/`pushd` target inside the world before the shell starts, up to
  the first `||`, pipe, `&` or subshell, after which the directory depends on what ran. It
  turns `cap`, `missing-objects`, `failed` and `unknown-repo` into a readable deny. A daemon that
  is down or doesn't know the thread lets the command run; the daemon's check-out on `cd` covers
  it. Codex has no hook and relies on that.
- **State.** `status` from the daemon becomes `world` on the VCS local status
  (`VcsStatusBroadcaster`) and on `t3_worktree_status`. A refusal whose caller is this server's
  pid is labelled as Claude's Bash hook.
- **Touched repos.** Whenever a local status read finds a thread world's checked-out repos
  changed (every turn's end refreshes it), `WorldRepoSync` records them on the thread as
  `worldRepos` through a server-only field of `thread.metadata.update`, which keeps the thread's
  `updatedAt`. Lists show them without asking the daemon, and keep them after teardown: a status
  with no repos, or from a daemon that didn't answer, records nothing.
- **Teardown (decision 2).** Every 10 minutes the sweep looks at each thread world. It runs
  `agent-exec retire --remove-checkout` only when its threads are settled, archived or deleted and
  quiet for 6 hours (past a provider session's longest pin), the daemon answers and reports no
  repo `lostOnTeardown`, and no file lies outside the repos (`world/worldTeardown.ts`). It reads the
  threads again and retires under the workspace lease turn startup takes, so no thread resumes in
  between. agent-exec asks the daemon again and keeps everything on a refusal. Explicit deletion
  goes through `ManagedWorkspaces.removeWorktree`, which retires the same way. An unregistered
  thread world goes only by removing empty directories, so any file keeps it.
- **No world, no host.** A provider session whose cwd is a world's project root, as for a thread
  whose world could not be created, is refused instead of running on the host.

## Clients

Hauke picks between two worlds and nothing else (fu-c318c751), so the thread lists are organized
around them:

- **One project per world.** Each machine keeps its own world project; project grouping keys
  them by `world`, so they are one project on every client.
- **Filing.** Every project belongs to a world or to none (`fileProjectsIntoWorlds` in
  client-runtime `state/worlds.ts`): a world project to its world, and an older per-repo or
  umbrella project to the world whose `path` holds it (the innermost, when world paths nest),
  else to the world whose catalog holds its repository's namespace (`git.buildlinx.io/buildlinx`,
  `github.com/haukeschnau`). The `path` is the one the project's own server declares; only a
  server that declares no worlds, such as dev-hauke before its update, uses another's. Each server reads its worlds' namespaces from the
  worldfs catalogs (`world/worldCatalog.ts`) and sends them in its config, so filing doesn't
  depend on which threads a client has loaded; a namespace two worlds hold files nothing, and a
  catalog change reaches clients when they reconnect. Scratch threads and everything else are
  outside worlds. Older projects keep running next to the worlds until Hauke switches.
- **Lenses.** A world scope key (`worldScopeKey`) stands for every project filed under a world.
  Web's sidebar shows the worlds as a segmented control under search, each with its needs-you
  count; pressing one scopes the inbox, search, drafts and new threads like a chosen project
  would. A new thread, from the button or its shortcut, starts in the world's own project on
  any machine, even with an older project's thread open or a machine filter set, and opens the
  project picker when no machine has one. Mobile shows the worlds as pills (iOS) or filter
  entries (Android) that set the same key as the list's project filter. A repository's
  clones can sit in different worlds, so a lens admits a whole repository group and then keeps
  only the clones filed under it; route reveal sees the same narrowed projects.
- **Rows.** A world thread's card names the repos it checked out instead of its project, with a
  dot on one that holds work no remote has; every thread card filed under a world gets the
  world's color down its edge, dashed (fainter on mobile) for an older project, while settled
  rows stay plain on both clients. The web card names the
  machine only when it isn't the server the client is connected to.
- Web: `ThreadWorldPanel` in the thread details card; the Version Control row hides for world
  projects and thread worlds, whose roots are no repository.
- Mobile: the thread header's git menu becomes a World menu for a thread world.
- Both offer no workspace choice for a world project (`managedWorkspacesForProject` returns null,
  and the composers' `canChooseWorkspace` is false).

## Upstream touch points

- contracts: `world.ts` (fork-only), `world` on project shells, `project.created` and VCS local
  status, `worlds` in settings and the patch, `world` on `WorktreeMcpStatusResult`,
  `worldRepos` on threads and `thread.metadata.update`.
- server: `orchestration-v2/ThreadLaunchService.ts` (one normalization),
  `orchestration-v2/CheckpointCaptureService.ts` (one `turnEnded` after the jj seal), `ProviderSessionManager.ts`
  (one `ensure` before the workspace check), `Adapters/ClaudeAdapterV2.ts` (the PreToolUse
  matcher), `vcs/VcsStatusBroadcaster.ts`, `ProjectStore.ts`, `ProjectCommands.ts`,
  `ProjectService.ts`, `mcp/WorktreeMcpService.ts`, `server.ts`.
- server `orchestration-v2/WorldRepoSync.ts` (fork-only) and its line in `runtimeLayer.ts`;
  `ThreadManagementService.ts` strips the server-only field from client commands; `ws.ts` sends
  `worldNamespaces` in the server config (contracts `server.ts`).
- web `ThreadDetailsPanel.tsx`, `ChatView.tsx`, `Sidebar.tsx` (the scope expansion, the lens
  row, a row's world props), `shortcuts/chatRouteCommands.ts` (the lens's New thread),
  `sidebar/SidebarThreadRow.tsx` (first line, stripe, machine); mobile `ThreadGitControls.tsx`,
  `new-task-flow-provider.tsx`, `HomeScreen.tsx`, `HomeRouteScreen.tsx`,
  `ThreadNavigationSidebar.tsx`, `thread-list-v2-items.tsx`, `AdaptiveWorkspaceLayout.tsx` and
  `new-task-project-selection.ts` (the lens's New), `homeThreadList.ts` and every caller of
  `resolveHomeProjectFilterScope`; client-runtime `state/workspaces.ts`, `state/models.ts`,
  `state/projectGrouping.ts` (one key).

## What this does not replace yet

The BuildlinX and Schnau worlds run next to `~/Buildlinx` and the other umbrella projects until
Hauke switches (decision 5), and nothing has moved to worlds yet. So agent-exec's directory
projects, the guarded directory copy in [Workspaces](workspaces.md) and isolated workspaces all
keep callers, and this patch removes none of them. [worldfs](worldfs.md) lists what goes once
the switch is done.

## Removal

Remove this with [worldfs](worldfs.md): when upstream ships lazy multi-repository workspaces, or
when fleet worlds are retired.
