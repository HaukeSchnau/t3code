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

- The Codex Desktop bundle includes a dedicated local conversation `threadHandoff` workflow. The shipped locale strings include progress steps for creating/reusing worktrees, detaching worktree branches, stashing source and target changes, preparing host transfer files, copying artifacts to the target host, moving the thread to local/worktree/host worktree, rolling back changes, and success/warning/error toasts.
- The app separates local conversations and cloud/remote tasks, with UX for applying remote changes locally.
- The side-chat fork path calls `fork-conversation-from-latest` with `addForkedSyntheticItem: false` and appends developer instructions saying the new conversation is a side conversation, not the main thread. This suggests Codex separates user-visible synthetic history/progress items from agent-facing instructions when the destination thread needs altered behavior.
- Inference: for normal fork/handoff flows, Codex likely records user-visible synthetic/progress state and uses developer instructions only when the model needs behavior context. The minified bundle was not enough to prove exactly what the normal handoff prompt contains.
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

Ship Option A and present it through the existing fork affordance as a `Fork...` destination menu, with transparent handoff metadata:

- source thread gains a handoff activity/status,
- destination thread says where it came from,
- after success, source remains available for now and gets an explicit link to the destination.

Use `handoff` as the internal operation name for the workspace/host transfer mechanics. Use `Fork to...` or `Fork in...` in the UI while source threads remain present, because that is the honest user-facing model.

## Proposed UX

Entry points:

- Existing fork button becomes a menu instead of a single action:
  - `Fork here`
  - `Fork into new workspace`
  - `Fork to host...`
  - `Fork to host workspace...`
- Optional thread overflow/sidebar context menu can reuse the same `Fork to...` action.
- Disabled for archived/deleted threads.
- Disabled while a thread is running, waiting on approval, or waiting on user input. First version requires idle source threads.

Dialog:

- Destination host/environment selector.
- Destination project selector, defaulting to matching repository identity/path when available.
- Workspace mode:
  - `Same project checkout` when destination project is already isolated or user only changes host.
  - `New workspace` for same-host isolation.
  - Possibly `Auto` as the default, resolving to a new workspace when source and destination project are the same physical checkout.
- Confirmation copy should name both current and destination host/workspace.

Post-success behavior:

- Navigate to destination thread.
- Show a lightweight banner/activity: `Forked from <source thread>`.
- Source thread gets `Forked to <destination thread>`.
- Keep source thread available in the first version.

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
})
```

Server flow:

1. Load source thread, project, provider binding, and latest snapshot.
2. Validate source is idle: no running turn, pending approval, pending user input, or active provider process.
3. Resolve target environment and project.
4. Verify or create matching target workspace state:
   - Same-host workspace isolation can use the existing workspace/worktree service.
   - Cross-host handoff should provision a destination workspace and synchronize the necessary repo/files before the thread is created there.
   - Matching state is a hard requirement; fail loudly if T3 cannot prove or create it.
5. Create destination thread.
6. Copy/import transcript:
   - Codex-backed: use Codex App Server fork/import when source and destination can access compatible Codex provider state.
   - Cross-host Codex: likely requires source server to fork/export, then destination to import; this is the riskiest unknown.
   - Non-Codex: unsupported for the first implementation.
7. Append handoff/fork relationship activity on both source and destination.
8. Add a one-shot destination context instruction for the next Codex turn, and record a user-visible synthetic/activity item for both humans and history.

## Agent-Facing Handoff Context

Add both records, for different audiences:

- Human-visible: a synthetic orchestration activity/event in T3 history, e.g. `Forked from <source> on <host/path> to <destination> on <host/path>`.
- Agent-facing: a one-shot developer/system instruction on the destination Codex thread, not an ordinary user message.

Recommended destination instruction shape:

```text
This thread was forked by the user from an earlier T3 Code thread.
The conversation history was imported, but execution is now in a different workspace and/or host.
Current host: <target-host>
Current working directory: <target-cwd>
Source host: <source-host>
Source working directory: <source-cwd>
Repository state was synchronized by T3 Code before this thread was created.
Continue from the imported conversation, but use the current working directory and host as authoritative.
```

Rationale:

- The model needs to know not to assume stale paths, terminals, approvals, or host-local state from the source thread.
- The user should see that a fork/handoff occurred even if no model turn has run yet.
- Making it an ordinary user message would pollute the conversation and make it look like the user asked for behavior; this is runtime context.

## Data Model Additions

Likely additions:

- Relationship activity kind: `handedOffTo` / `handedOffFrom`, or generic `movedTo` / `movedFrom`.
- Optional destination/source refs include `environmentId`, `threadId`, `projectId`, and `workspaceId`.
- Optional thread status/read-only marker may be useful later if source should stop accepting new messages after handoff.

Avoid moving environment IDs into core thread identity unless a larger cross-environment identity model is introduced.

## Hard Questions

- What should count as "matching repo state" for cross-host handoff?
  - same VCS type (`jj`/git),
  - same root,
  - same commit/change id,
  - uncommitted tracked changes,
  - untracked generated files,
  - ignored files,
  - secrets/config files.
- Should T3 copy workspace files across hosts by default, or require an explicit file sync confirmation?
- Can Codex App Server fork/import provider threads across machines, or only within the same Codex home/session store?
- What should the non-Codex provider story be later: transcript-only continuation, provider-specific fork APIs, or unsupported?
- How much should the source thread be locked after a destination fork is created, if at all?

## Suggested Phases

1. Done: replace the assistant-message fork button action with a fork destination menu, keeping the existing same-thread/same-checkout fork path intact.
2. Done: same-host, new-workspace fork for idle Codex-backed threads, with relationship activities and destination context instruction. First implementation uses managed `directory-copy` workspaces for matching dirty/untracked file state, and the user-facing RPC only accepts that workspace kind.
3. Cross-host Codex fork where T3 creates a destination workspace and synchronizes matching repo/file state before creating the thread.
4. Source disposition options such as archive/read-only/close source, if the duplicate-thread UX becomes noisy.
5. Non-Codex provider support and active-turn policies, if user pressure proves the complexity is worth it.

## Verification Plan

- Unit tests for handoff command validation and relationship events.
- Service tests for workspace preparation cleanup on failure.
- Remote-routing tests covering local-to-remote and remote-to-local handoff requests.
- Codex-backed integration test proving destination thread can continue after imported history.
- Manual UI test:
  - move local thread to new workspace,
  - move local thread to registered SSH/Tailscale environment,
  - failure while preparing workspace leaves source usable and destination absent/marked failed.

## 2026-07-07 Implementation Notes

- Implemented the first slice as a destination-aware assistant-message fork menu.
- The UI exposes fork actions only for Codex-backed active threads; monitor tiles remain read-only.
- The server rejects non-idle sources and mirrors stale approval/user-input failure handling so stale requests do not block forks forever.
- `CodexThreadForkImporter` rolls back a partially-created destination thread if later import/binding/session setup fails. The caller then deletes any prepared workspace, avoiding dangling threads that point at removed checkouts.
- The agent-facing orchestration `fork_thread` path now rejects running/busy sources before workspace preparation too. This closes a gap found during live E2E probing where the tool path could fork only completed history from a still-running source.
- Browser validation confirmed the menu renders with `Fork here`, `Fork into new workspace`, and disabled `Fork to host...`.
- Browser validation also hit the expected directory-copy guard for threads whose source cwd is `/Users/haukeschnau`: managed workspaces under `~/.t3/workspaces` would be inside that source root, so the fork fails before creating a destination workspace. This is a guardrail, not the normal project-root path.
- Live orchestration E2E from a completed Codex thread in `/Users/haukeschnau/Code/t3code` successfully created a managed workspace fork at `/Users/haukeschnau/.t3/workspaces/t3code/t3code-mcpforkf1973`, cloned the transcript, and recorded a fork relationship activity.

## Open Assumptions

- "Move" should be implemented as a linked destination thread rather than mutating the original thread identity.
- First version requires the source thread to be idle.
- First version is Codex-only.
- First cross-host version may create the destination workspace and sync files rather than requiring the project checkout to already exist.
- Source threads remain visible and usable for now.
- It is acceptable to document fork-specific handoff behavior in `patches/*.md` when implementation begins.
