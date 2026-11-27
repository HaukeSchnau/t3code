# Storage cleanup of managed workspaces

Upstream's storage cleanup (`apps/server/src/storageCleanup.ts`) removes Git worktrees in the
worktree folders and the folders of No project threads. The fork's managed workspaces
(`workspaces.md`) live in `<baseDir>/workspaces`, which upstream never looks at, and a deleted No
project thread's folder stayed forever because deleted threads only counted with a branch. On
srv-2 that left about 100 jj workspaces of 3 to 9 GB each, most of them for settled threads.

## Behavior

- A jj workspace in `<baseDir>/workspaces/<project>/<name>` follows the worktree rules of its
  project: inactive days, settled days, deletion, merge and unchanged. Merge means every pull
  request linked to its threads is closed and at least one merged, from T3's own pull request
  snapshots, since a jj workspace has no branch to look up. Unchanged means no non-empty change in
  `trunk()..@` once its thread is settled or archived.
- Before removal, and again under the workspace lease, cleanup snapshots the working copy with a
  plain `jj status`. It keeps the workspace when jj could not snapshot, when jj left files out of
  `@` (over `snapshot.max-new-file-size`, or outside `snapshot.auto-track`), or when a non-empty
  change reachable from `@` is on no remote bookmark or remote tag. The upstream checks still
  apply: running or queued work, live terminals and provider sessions anywhere in the workspace,
  a project checkout inside it, nested Git repositories, and other threads working in another
  folder of the same workspace. Remote bookmarks are read as of the last fetch; cleanup never
  fetches.
- **Any local files** also keeps a workspace with ignored files other than `node_modules`. jj can
  not list ignored files, so a workspace without a colocated Git repository stays under that rule.
  The other two keep rules behave alike for jj, since the snapshot turns untracked files into
  changes of `@`.
- Removal runs `jj workspace forget` and deletes the folder. When a live thread may still resume
  there, cleanup first writes the workspace's name and the commits of `@` (its parents while `@` is
  empty) to `<stateDir>/removed-jj-workspaces/`. Turn start's missing-worktree restore recreates
  the workspace from that record with `jj workspace add` and runs the project's setup, as it does
  for a removed Git worktree. The recreated workspace's jj name carries a hash of its path, since
  the old name may belong to another project's workspace by then, and concurrent restores of
  other paths must not pick the same one. A restore that jj did not register keeps its record.
  Records whose workspace no remaining thread names are dropped at each sweep. While any thread
  names a folder inside a workspace, new workspaces never take that workspace's path.
- Colocated workspaces also stay while Git holds a staged edit or a paused rebase, merge,
  cherry-pick or revert, and an agent-exec fork stays while its repository has a Git stash.
- An agent-exec fork (an isolated workspace with its own jj repository) is removed only once its
  thread is deleted, with `agent-exec retire --remove-checkout`, and only when no non-empty change
  in its whole repository is missing from a remote bookmark or tag. Nothing recreates a fork for a
  thread that resumes.
- Directory copies and isolated workspaces of plain directories have no history that shows what a
  remote holds, so cleanup keeps them and says so.
- A deleted No project thread's folder is removed under **Delete worktrees with deleted threads**,
  with the same checks as an inactive one: under the default keep rule only a folder holding
  nothing but `node_modules` goes.

## Upstream hooks

- `storageCleanup.ts`: deleted threads count when they have a branch, a No project folder or a
  managed workspace; `managedWorkspaceRoot` and the managed-workspace block before the task-folder
  block; `measureWorktree`'s `"jj"` mode, which treats the workspace's own `.git` and `.jj` as part
  of it; `ignoredFilesReason`, split out of `localChangesReason`; the layer provides
  `ProcessRunner` for jj and agent-exec.
- `workspace/restoreMissingWorktree.ts`: `recreateJjWorkspace` before the No project folder for a
  thread without a branch. `WorktreeRecreateError.branch` is optional for it. The spawner is read
  with `Effect.serviceOption`, so the layer keeps upstream's requirements.
- Fork-owned: `workspace/JjWorkspaces.ts` (`inspectJjWorkspace`, `jjWorkspaceName`, `revisions` on
  `createJjWorkspace`, whose failure cleanup forgets only a workspace registered at its
  destination), `workspace/removedJjWorkspaces.ts`, and `ManagedWorkspaces.referencedPaths`, which
  reserves the workspace of every folder a thread names.

## Not carried over

- Workspaces no thread names are not reported as orphans, unlike folders in the worktree folders.
- Placement clones (`fleet-placement.md`) are not cleaned up yet.

## Removal

Drop the workspace parts with `workspaces.md`, once upstream creates and cleans up jj workspaces.
Drop the deleted No project folder change once upstream's deletion cleanup covers those folders.

## Verification

`storageCleanup.test.ts` "managed workspaces", and `workspace/restoreMissingWorktree.test.ts`.
