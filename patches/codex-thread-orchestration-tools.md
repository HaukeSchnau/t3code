# Codex Thread Orchestration Tools

T3 Code exposes Desktop-style thread orchestration primitives to Codex-backed agents.

The patch exposes `list_projects` as the normal discovery entrypoint for
orchestrators. It returns local and registered remote environments plus their
projects, so agents can choose a `projectId` or `environmentId` without learning
provider/model details.
For the common case, `create_thread` can omit both `target` and `modelSelection`;
it defaults to a sibling thread in the calling thread's current project, current
environment, current provider/model/options, runtime mode, and interaction mode.
Supplying `target.environment.type: "worktree"` or an explicit `modelSelection`
is reserved for intentional isolation or provider/model fanout.

Provider/model discovery is exposed separately through `list_thread_models`.
That tool returns curated model choices with exact `modelSelection` objects that
can be passed to `create_thread.modelSelection`, plus compact reasoning metadata
when a provider exposes a reasoning selector. Agents are instructed not to call
it for ordinary child threads. Hidden orchestration models such as small, stale,
or internal models are omitted and cannot be explicitly selected via the
orchestration tools, though existing threads may continue to inherit their
current model settings.

Remote host orchestration is represented explicitly through `environmentId`.
The local T3 server owns a backend-to-backend remote orchestration registry,
persisting non-secret remote metadata in `remote-orchestration-environments.json`
and storing bearer access tokens in `ServerSecretStore`. `t3 remote register`
can exchange a one-time remote pairing token for an orchestration-scoped bearer
session and register the remote host. `list_projects` returns both the current
environment and registered remotes; agents pass the returned `environmentId` to the
existing thread tools rather than using a separate remote-only tool family. Omitting
`environmentId` preserves the current host/current project/current provider defaults.

This fork-specific patch extends the existing MCP thread toolkit with compact passive
observability tools:

- `read_thread_result` returns thread status, queue count, and latest messages without
  loading the full transcript.
- `await_thread` waits for a thread to become idle, complete its latest turn, or drain its
  queued messages.
- `get_thread_graph` returns automatic relationship edges between threads without mutating
  the graph being inspected.

Full `read_thread` still records `readBy` activity when one thread reads another. The compact
tools are intentionally passive so orchestration agents can poll and inspect cheaply without
contaminating the relationship graph.

The patch also routes Codex-backed agent `fork_thread` calls through Codex App Server.
Forking asks Codex App Server to run `thread/fork`, then imports the returned copied
history into T3 Code and binds the new T3 thread to the forked Codex provider thread.
This keeps transcript cloning semantics owned by Codex App Server instead of
reimplementing them in T3 Code.

Assistant messages also expose a message-level "Fork from here" action. This is a UI affordance
over Codex App Server's `thread/fork.lastTurnId` parameter: T3 Code validates that the selected
message is a completed assistant message with a Codex turn id, passes that turn id to Codex, then
imports the terminal-prefix fork that Codex returns. The vendored `effect-codex-app-server`
schema is patched to include `thread/fork.lastTurnId`; otherwise its JSON-RPC request encoder
drops the field before it reaches Codex. For older installed Codex binaries that accept but ignore
`lastTurnId`, T3 Code rolls the newly forked provider thread back by the extra trailing turns before
importing and binding it. T3 Code no longer exposes a separate user-facing latest-thread fork
action in the sidebar; message-level forking is the user workflow.

The message-level fork action is destination-aware. The fork button opens a menu with:

- `Fork here`, preserving the existing same-workspace behavior.
- `Fork into new workspace`, which asks `ThreadWorkspaceService` to create a managed
  `auto` workspace from the source thread's current cwd before calling Codex App Server
  `thread/fork` with the prepared cwd. On JJ repositories this resolves to a cheap
  `jj-workspace`; `directory-copy` is reserved for explicit preservation of ignored or
  untracked runtime state.
- A disabled `Fork to host...` placeholder. Cross-host Codex continuation remains blocked
  until provider-thread transfer/export semantics are proven.

The user-triggered Codex fork RPC is intentionally Codex-only and idle-only. The server rejects
archived sources, running latest turns, active provider turns, streaming messages, queued messages,
pending approvals, and pending user-input requests before preparing any workspace or forking provider
history. The agent-facing thread orchestration `fork_thread` path also rejects busy sources before
preparing a workspace, so explicit UI handoffs and tool-driven worktree forks do not diverge on the
"source must be idle" rule. The public RPC accepts `auto` and `directory-copy`, defaulting to
`auto` so repository-backed projects avoid copying dependency directories and other ignored payloads.
The "Fork into new workspace" path and the regular "start new thread in workspace" bootstrap path
share the same server-side workspace preparation helper so workspace kind defaults, root normalization,
display names, and retention policy cannot drift between those user-visible workflows again.
If a prepared-workspace fork fails after creating a destination thread, T3 rolls the destination
thread back before deleting the prepared workspace.

On successful workspace forks, the destination T3 thread stores the prepared `workspaceId` and
`worktreePath`, while Codex receives developer instructions that mark the destination cwd as
authoritative and explain that the conversation was forked from another T3 thread. T3 also records
`thread.forked-to` and `thread.forked-from` activities so the relationship is visible to humans even
before another model turn runs.

The WebSocket entrypoint only delegates Codex resume/fork RPCs. Keep provider selection, settings and
environment resolution, shadow-home materialization, import deduplication, busy/fork-point validation,
workspace cleanup, and relationship activities in `apps/server/src/provider/CodexThreadRpcWorkflow.ts`.
