# Workspace Substrate

T3 Code carries a fork-specific workspace substrate that replaces the older
Git-branch-backed "worktree" execution model with a first-class Workspace
projection.

## Why This Patch Exists

The upstream worktree model assumes a Git repository and a branch-backed
checkout. This fork needs a substrate that can support:

- detached Git worktrees,
- Jujutsu workspaces,
- isolated directory copies for non-VCS projects,
- future multi-root orchestration.

The first shipped slice keeps the existing UX mostly intact while renaming the
visible concept to "Workspace" and introducing storage/contracts that can
support non-Git backends.

## Current Behavior

- New managed workspaces are requested through `prepareWorkspace`.
- Managed checkout names are derived once from the creation-time display-name seed and normalized
  for filesystem and DNS use. A numeric suffix appears only when the project has already claimed
  the same semantic name. The same naming rule applies to detached Git, Jujutsu, and directory-copy
  workspaces. Jujutsu uses the semantic name for both its workspace and checkout path. Later
  automatic thread-title refreshes do not rename a live workspace because
  terminals, setup scripts, and external development tooling may already hold its path.
- Legacy `prepareWorktree` requests are still accepted and translated into a
  single-root `git-detached` workspace request.
- Threads now carry `workspaceId` in addition to compatibility `branch` and
  `worktreePath` fields.
- Managed workspace records live in `projection_thread_workspaces` and
  `projection_thread_workspace_roots`.
- All managed provisioners persist the deterministic workspace/root identities in `preparing` state
  before their external filesystem/VCS operation. Bootstrap retry reuses an active record; an
  incomplete record is reconciled by removing its deterministic checkout/worktree registration and
  then reprovisioning, so process interruption does not create a second logical workspace or orphan
  the first checkout.
- Directory-copy workspace preparation persists a `preparing` workspace row before
  starting the filesystem copy, then marks it `active` on success or `failed`
  with `failureDetail` if provisioning fails. This keeps long-running or stuck
  non-VCS copies visible to diagnostics and cleanup tooling.
- Directory-copy provisioning refuses sources whose checkout path would be
  created inside the source tree, refuses sensitive roots such as the user's home
  directory and T3's workspace storage, and measures source size before copying.
  Ordinary full-copy sources larger than `T3CODE_DIRECTORY_COPY_MAX_BYTES`
  (default 5 GiB) still fail fast.
- On macOS APFS and Linux BTRFS, directory-copy workspaces use a guarded
  copy-on-write operation when the filesystem topology supports it: APFS uses
  same-device `cp -cR`; BTRFS uses GNU `cp -a --reflink=always` when both source
  and checkout parent are BTRFS. These paths bypass the logical source-size cap,
  require only bounded transient free space, monitor free space while copying,
  and refuse unsafe full-copy fallback when the logical source is too large.
- Directory-copy filesystem work is asynchronous with bounded `du` and copy
  timeouts, so long copies do not block the server event loop. Metadata exposes
  `preparationStatus`, copy timing, source size, free space, and copy strategy
  while provisioning is in progress. APFS clone-on-write copies use a direct
  monitored process so they can be stopped if transient disk usage grows beyond
  the guard.
- On CoW-capable filesystems, directory-copy workspaces use the filesystem clone
  path before falling back to `rsync` only when a full-copy fallback is safe;
  non-CoW paths use recursive `cp` before the same fallback.
- Workspace deletion uses a hardened recursive removal path that first retries
  normally, then makes copied files/directories user-writable before a final
  remove attempt. This handles package caches that contain read-only files while
  avoiding chmod of symlink targets.
- Cwd resolution prefers the workspace primary root checkout path, then falls
  back to legacy `worktreePath`, then the project root.
- Git workspaces are created with `git worktree add --detach`.
- JJ and directory-copy provisioning are present behind the same service shape;
  JJ automatic per-turn history is currently a placeholder service.
- Web UI labels use "Workspace" while preserving old persisted `worktree`
  values for compatibility.

## Compatibility Notes

Do not remove these compatibility fields in upstream syncs unless the fork has
completed a separate cleanup migration:

- `branch`
- `worktreePath`
- `prepareWorktree`
- `T3CODE_WORKTREE_PATH`
- `runOnWorktreeCreate`

The `worktreePath` compatibility value should remain equal to the primary root
checkout path for managed workspaces while legacy consumers still exist.

## Upstream Sync Checklist

- Keep `workspaceId` nullable for old local-checkout threads.
- Preserve migration backfill for legacy rows with `worktree_path`.
- Verify `prepareWorktree` still translates server-side.
- Verify web first-send emits `prepareWorkspace`.
- Verify cwd resolution still falls back to `worktreePath` before project root.
- Re-check detached Git publishing flows before changing source-control actions.
