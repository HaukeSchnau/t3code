# Thread Handoff Spec Notes

## Goal

Design a user-triggered handoff action that moves useful continuity from an existing thread to:

- a separate workspace in the same environment,
- a different execution environment/host,
- or both.

Primary motivation: keep long-running work alive on a remote machine, or isolate a thread from other active threads in the same project.

## Current Repo Context

- T3 Code already has first-class environment IDs and remote orchestration registration.
- Agent-side orchestration can already create threads in remote environments via `target.environmentId`.
- Agent-side orchestration can already create/fork into a prepared workspace via `target.environment.type: "worktree"` / workspace service.
- Codex-backed fork imports use Codex App Server `thread/fork`, then import the cloned provider history and bind the new T3 thread.
- `thread.create` already stores `workspaceId`, `branch`, and `worktreePath`.
- `thread.meta.update` can update workspace metadata for an existing thread, but changing the execution location of a live provider session is not currently modeled.

## Codex.app Reference Notes

- The visible Codex Desktop UI exposes fork and side-chat actions rather than a literal user-facing "handoff" action in the inspected bundle.
- The app separates local conversations and cloud/remote tasks, with UX for applying remote changes locally.
- Inference: Codex appears to lean toward "start/clone elsewhere and link results" rather than mutating an existing local thread into a different host in place.
- T3's existing Codex App Server fork importer is the strongest local primitive to reuse for transcript/session continuity when the provider is Codex-backed.

## Product Model Options

### Option A: Handoff As Linked Fork

Create a destination thread, copy/import transcript where possible, start/resume there, then mark the source thread as handed off.

Pros:

- Fits existing `thread.create`, `thread.messages.import`, provider binding, workspace provisioning, and remote routing.
- Avoids pretending a provider process can teleport between hosts.
- Keeps failures recoverable: source thread remains available until destination is confirmed.
- Works across environments because thread/project identity is environment-local today.

Cons:

- It is not a literal same-thread move.
- Sidebar/history must make the link obvious to avoid duplicate-thread confusion.

### Option B: Handoff As In-Place Migration

Mutate the existing logical thread to point at a new project/workspace/environment.

Pros:

- Most closely matches "move this thread".
- Avoids duplicate sidebar rows.

Cons:

- Conflicts with current environment-local thread IDs and storage.
- Hard for remote hosts because the source server cannot own destination persistence.
- Dangerous around live sessions, approvals, terminals, filesystem paths, and provider binding.

### Recommended Direction

Ship Option A and present it as "Move to..." in the UI, with transparent handoff metadata:

- source thread gains a handoff activity/status,
- destination thread says where it came from,
- after success, source is stopped and optionally archived/read-only.

This gives users the result they want while preserving a robust implementation boundary.

## Proposed UX

Entry points:

- Thread overflow menu: `Move to...`
- Optional sidebar context menu: `Move to...`
- Disabled for archived/deleted threads; gated for in-progress turns until interruption policy is defined.

Dialog:

- Destination host/environment selector.
- Destination project selector, defaulting to matching repository identity/path when available.
- Workspace mode:
  - `Same project checkout` when destination project is already isolated or user only changes host.
  - `New workspace` for same-host isolation.
  - Possibly `Auto` as the default, resolving to a new workspace when source and destination project are the same physical checkout.
- Source handling:
  - `Stop source thread after handoff` default on.
  - `Archive source after handoff` default off or on depending on product taste.
- Confirmation copy should name both current and destination host/workspace.

Post-success behavior:

- Navigate to destination thread.
- Show a lightweight banner/activity: `Moved from <source thread>`.
- Source thread gets `Moved to <destination thread>` and becomes read-only or idle/stopped.

## Backend Shape

Add a user-facing environment RPC, not an MCP-only tool:

```ts
thread.handoff({
  source: { environmentId, threadId },
  target: {
    environmentId,
    projectId,
    workspace?: { type: "same" | "new", kind?: "auto" | "git-detached" | "jj-workspace" | "directory-copy" },
  },
  sourceDisposition?: {
    stop?: boolean,
    archive?: boolean,
  },
})
```

Server flow:

1. Load source thread, project, provider binding, and latest snapshot.
2. Validate no active approval/user-input deadlock or define how it transfers.
3. Resolve target environment and project.
4. If requested, prepare target workspace on the destination environment.
5. Create destination thread.
6. Copy/import transcript:
   - Codex-backed: use Codex App Server fork/import when source and destination can access compatible Codex provider state.
   - Cross-host Codex: likely requires source server to fork/export, then destination to import; this is the riskiest unknown.
   - Non-Codex: fall back to T3 transcript import plus a fresh provider session with a handoff summary prompt.
7. Append handoff relationship/activity on both source and destination.
8. Stop and/or archive source after destination creation succeeds.

## Data Model Additions

Likely additions:

- Relationship activity kind: `handedOffTo` / `handedOffFrom`, or generic `movedTo` / `movedFrom`.
- Optional destination/source refs include `environmentId`, `threadId`, `projectId`, and `workspaceId`.
- Optional thread status/read-only marker may be useful if source should stop accepting new messages after handoff.

Avoid moving environment IDs into core thread identity unless a larger cross-environment identity model is introduced.

## Hard Questions

- Should handoff of an actively running turn interrupt first, wait until idle, or allow a live continuation summary while source keeps running?
- For remote host handoff, how do we ensure the destination has the right code state?
  - same git remote/revision,
  - local uncommitted changes,
  - generated files not committed,
  - secrets/config files.
- Should T3 ever copy workspace files across hosts, or require the destination project to already exist?
- Can Codex App Server fork/import provider threads across machines, or only within the same Codex home/session store?
- What is the non-Codex provider story: transcript-only continuation, provider-specific fork APIs, or unsupported at first?
- How much should the source thread be locked after handoff?

## Suggested Phases

1. Same-host, new-workspace handoff for idle Codex-backed threads.
2. Same-host handoff with explicit source stop/archive and UI relationship banners.
3. Cross-host handoff where destination project already exists and transcript continuation is enough.
4. Rich cross-host Codex handoff if provider-thread export/import can be made reliable.
5. Active-turn handoff policies and workspace file transfer, if user pressure proves the complexity is worth it.

## Verification Plan

- Unit tests for handoff command validation and relationship events.
- Service tests for workspace preparation cleanup on failure.
- Remote-routing tests covering local-to-remote and remote-to-local handoff requests.
- Codex-backed integration test proving destination thread can continue after imported history.
- Manual UI test:
  - move local thread to new workspace,
  - move local thread to registered SSH/Tailscale environment,
  - failure while preparing workspace leaves source usable and destination absent/marked failed.

## Open Assumptions

- "Move" can be implemented as a linked destination thread rather than mutating the original thread identity.
- First version can require the source thread to be idle.
- First cross-host version can require the destination project to already exist.
- It is acceptable to document fork-specific handoff behavior in `patches/*.md` when implementation begins.
