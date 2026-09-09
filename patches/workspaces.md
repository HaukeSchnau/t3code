# Workspaces

A project can contain several workspaces, and several threads can use one workspace.
Files, tool configuration, services and previews belong to the workspace. A thread
owns its conversation and model selection. Starting a new conversation in an existing
workspace retains its files and runtime without copying another thread's messages.

The composer on web, desktop and mobile chooses a new workspace, an existing one, or
the project checkout. Project-scoped lists group active conversations by workspace;
pinned order and orchestration trees stay intact. A workspace leaves the normal picker
when all its threads settle or archive. Search and Show settled reuse the existing
archive query to find retained workspaces. Merely reading history does not wake work.
Settlement never merges or deletes files, and preview leases remain independent.
Explicit deletion refuses workspaces still referenced by active or running threads.

On Linux with `T3CODE_EXECUTION_LAUNCHER`, automatic repository workspaces use the
private infra runtime's independent jj checkout and execution environment. Git sources
and shared jj workspaces are supported. Other hosts retain detached Git worktrees,
shared jj workspaces and guarded directory copies. The existing project checkout and
configured thread defaults remain available. Advanced setup offers Familiar, which
retains global instructions and skills, or Minimal, which starts with project guidance.
Familiar is the default for a new isolated workspace. Codex and Claude/Claudex currently
support isolated execution; other providers fail explicitly at session startup.

The existing workspace projection and service own preparation, membership and deletion.
The creating thread supplies a deterministic provisioning id, not exclusive ownership.
Bootstrap retries reuse active workspaces. An isolated runtime registration can recover
provisioning whose acknowledgement was lost, preserving work already present. Runtime
creation is idempotent for the same workspace id and request. The launcher owns cloning,
private home/tool state, networking, collection and retirement. T3 does not duplicate
those implementations or register each workspace as a separate project.

Workspace names derive once from the creation-time semantic seed. Only live collisions
add a suffix; later thread-title changes do not rename paths used by terminals or tools.
Directory-copy preparation retains its size, free-space and sensitive-root checks.
APFS and BTRFS use bounded copy-on-write paths and refuse unsafe full-copy fallbacks.
Those filesystem operations remain asynchronous and persist progress before copying.

Compatibility fields `branch`, `worktreePath`, `prepareWorktree`,
`T3CODE_WORKTREE_PATH` and `runOnWorktreeCreate` remain during upstream integration.
`worktreePath` equals the primary checkout for managed workspaces. Selection by legacy
path binds the canonical workspace id; changing checkout clears or replaces that id.
Old nullable ids and duplicate legacy records are grouped by host, project and path.

The CLI exposes `t3 thread create --worktree --workspace-profile familiar|minimal` and
`--workspace ID` for reuse. Native outbox replay uses the same `prepareWorkspace`
bootstrap as web, including branchless repositories. Preserve these contracts, the
many-thread deletion guard, and the existing settlement lifecycle during upstream syncs.
