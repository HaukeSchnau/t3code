# JJ-First VCS Integration

## Goal

Make Jujutsu (JJ) the first-class local VCS path in T3 Code while keeping the existing `git.*` RPC and contract names for a small, fork-friendly patch. User-facing repository status, branch/bookmark selection, commit, sync, push, PR, and worktree actions should use JJ when a colocated `.jj` repo is present and fall back to the existing Git implementation otherwise.

## Requirements

- Preserve existing `git.*` WebSocket method names, web hooks, and contract type names.
- Add optional `vcs: "jj" | "git"` to status and branch listing results so UI copy can distinguish JJ from Git without renaming APIs.
- Keep `GitCore` as Git plumbing and as the fallback implementation for plain Git repositories.
- Add `JjCore` under `apps/server/src/git` for JJ operations.
- Add a routing service (`RepositoryVcs`) that delegates to JJ when `jj root --no-pager` succeeds for `cwd`, otherwise delegates to `GitCore`.
- Route user-facing VCS actions in `GitManager`, `GitStatusBroadcaster` paths, and WebSocket Git RPC handlers through `RepositoryVcs`.
- Preserve existing Git fallback semantics for non-JJ repos.
- Keep checkpoint hidden refs/tree operations, workspace indexing, repository identity remote parsing, GitHub CLI PR operations, and low-level Git remote plumbing on Git in v1.

## Defaults Chosen

- JJ-first fallback: colocated JJ repos use JJ; all other repos use existing Git behavior.
- Keep `git.*` API names for minimal downstream churn.
- Commit, push, and PR flows are bookmark-backed in JJ repos.
- Repository initialization uses colocated JJ with `jj git init --colocate <cwd>`.
- Sync uses fetch then rebase: `jj git fetch`, then `jj rebase -b @ -d <bookmark>@<remote>`.
- UI copy changes should be targeted through `vcs` rather than broad component renames.

## Non-Goals

- Rename Git contracts, RPC method names, or React hook names.
- Replace GitHub CLI behavior for PR creation/resolution.
- Replace checkpoint storage, hidden refs, or tree diff internals with JJ.
- Replace workspace file indexing commands that depend on Git plumbing.
- Rename all UI "worktree" copy to "workspace".
- Implement full JJ conflict resolution UX in this patch.

## JJ Command Mapping

- Detect JJ repo: `jj root --no-pager`
- Init repo: `jj git init --colocate <cwd>`
- Local status:
  - changed files: `jj diff --summary -r @`
  - totals/context: `jj diff --stat -r @` and `jj diff --git -r @`
  - current change/bookmarks: `jj log --no-graph -r @ -T ...`
- Current branch/bookmark:
  - prefer a local bookmark pointing at `@`
  - otherwise use the active thread bookmark when provided
  - otherwise report `null` and leave push/PR blocked until a bookmark exists
- List branches:
  - map local bookmarks to existing `GitBranch` rows
  - include remote bookmarks from `jj bookmark list --all-remotes`
  - preserve existing pagination/query behavior
- Create branch/bookmark: `jj bookmark set <name> -r @`
- Checkout branch/bookmark:
  - local bookmark: `jj edit <bookmark>`
  - remote-only bookmark: create a local bookmark from `<bookmark>@<remote>`, then `jj edit <bookmark>`
- Create worktree/workspace: `jj workspace add <path> -r <bookmark-or-rev> --name <safe-name>`
- Remove worktree/workspace: `jj workspace forget <workspace-name>`, then remove files if needed
- Commit: `jj commit -m <message>` or `jj commit <filePaths...> -m <message>`
- Feature branch: create a bookmark with the generated feature name before commit/push
- Push:
  - ensure publishing bookmark points at the committed revision with `jj bookmark set <bookmark> -r <rev>`
  - run `jj git push --remote <remote> --bookmark <bookmark>`
- Pull/sync:
  - run `jj git fetch --remote <remote>`
  - when a tracked remote bookmark exists, run `jj rebase -b @ -d <bookmark>@<remote>`
  - if the remote bookmark cannot be resolved or conflicts occur, surface the JJ error without silently falling back to Git pull

## Known Git Plumbing Intentionally Retained

- Checkpoint hidden refs and tree operations.
- Workspace file indexing through `git ls-files` / `git check-ignore`.
- Repository identity and remote parsing.
- GitHub CLI PR resolution and creation.
- Low-level Git remote setup/fetch/upstream plumbing needed by GitHub PR flows.
