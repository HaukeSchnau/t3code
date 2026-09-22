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

On Linux with `T3CODE_EXECUTION_LAUNCHER`, automatic workspaces use the
private infra runtime's independent checkouts and execution environment. Git sources,
shared jj workspaces and directory projects are supported. The launcher discovers nested
repository boundaries and returns their independent checkout revisions; T3 retains the
project directory as the primary root and registers the repositories as supporting roots.
Ordinary directory files use a lazy view with private writes, so untouched files can see
later source changes. Retained mounts outlive providers; deletion must go through the
launcher, which checks source dependencies before unmounting or removing private files.
Other hosts retain detached Git worktrees,
shared jj workspaces and guarded directory copies. The existing project checkout and
configured thread defaults remain available. Advanced setup offers Familiar, which
retains global instructions and skills, or Minimal, which starts with project guidance.
Familiar is the default for a new isolated workspace. Codex and Claude currently
support isolated execution; other providers fail explicitly at session startup.

The existing workspace projection and service own preparation, membership and deletion.
The creating thread supplies a deterministic provisioning id, not exclusive ownership.
Bootstrap retries reuse active workspaces. An isolated runtime registration can recover
provisioning whose acknowledgement was lost, preserving work already present. Runtime
creation is idempotent for the same workspace id and request. The launcher owns cloning,
private home/tool state, networking, collection and retirement. T3 does not duplicate
those implementations or register each workspace as a separate project.

Setup runs in the workspace's terminal. Its launch journal must be in the private home,
with separate host and terminal paths to the same files. The host's T3 userdata is not
mounted there. Setup cwd and environment variables use workspace-visible paths; the
source checkout is unavailable. Keep the journal's atomic claim and retry semantics.
The repository bootstrap uses pinned pnpm because Vite+ is installed by that step.
The setup wrapper is the PTY's initial process, so interactive shell configuration and
terminal capability queries cannot delay it. Cold toolchain activation has a five-minute
launch budget; the script has fifteen minutes after its durable launch acknowledgement.
Startup and completion timeouts must identify which stage failed.

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

Short-lived Codex metadata clients use the launcher's baseline environment. They
still see the registered workspace and provider credentials, but do not install
project dependencies while listing skills or checking account status. Agent
sessions and their shell commands retain normal native activation. In this repo,
worktree setup delegates dependency checks to the cached devenv task when already
inside its native environment; ordinary non-Nix setup still runs pinned pnpm.
Vite optimizes browser dependencies when the dev server starts; worktree setup
does not warm that cache before an agent can begin repository work.

Published image paths accept both `/srv/agent-share/...` inside a workspace and
its already-resolved `/srv/agent-share/isolated/<id>/...` host path. Preserve the
workspace-specific mapping and canonical-path checks when changing asset access.

Absolute media paths, including `/tmp`, resolve through the local thread workspace
before issuing signed asset URLs. Only links without a local thread use host paths
directly, preserving cross-environment links without bypassing workspace isolation.

Bootstrap progress follows upstream checkout, setup, and agent stages, but setup still waits for the durable completion journal before starting the provider. Cancelling after workspace preparation keeps the registered workspace. The upstream automatic "Work locally" retry assumes the workspace was deleted, so this fork requires a separate submission after cancellation instead.
