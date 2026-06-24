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
- Legacy `prepareWorktree` requests are still accepted and translated into a
  single-root `git-detached` workspace request.
- Threads now carry `workspaceId` in addition to compatibility `branch` and
  `worktreePath` fields.
- Managed workspace records live in `projection_thread_workspaces` and
  `projection_thread_workspace_roots`.
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
