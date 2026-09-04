# Codex thread orchestration CLI

T3 Code retains its Desktop-style thread orchestration implementation, but does
not register those MCP tools or advertise them to Codex-backed agents. The
operations are exposed through `t3 thread` commands instead. Codex provider
processes receive `T3CODE_THREAD_ID`, which supplies caller identity and normal
inheritance when the agent runs the CLI.

`t3 thread projects` is the normal discovery entrypoint. It returns local and
registered remote environments plus their projects. `t3 thread create` can
omit target and model flags. It then defaults to a sibling thread in the
caller's current project and environment with the current provider, model,
options, runtime mode, and interaction mode.

Provider and model discovery lives in `t3 thread models`. That command returns
curated choices with provider instance ids, model slugs, and compact reasoning
metadata. Those values map to `--provider-instance`, `--model`, and `--option`
on `create` and `send`. Agent instructions say not to call this command for
ordinary child threads.
Hidden orchestration models such as small, stale, or internal models are omitted
from explicit selection. Existing threads may still inherit their current model
settings.

Remote host orchestration is represented explicitly through `environmentId`.
The local T3 server owns a backend-to-backend remote orchestration registry,
persisting non-secret remote metadata in `remote-orchestration-environments.json`
and storing bearer access tokens in `ServerSecretStore`. `t3 remote register`
can exchange a one-time remote pairing token for an orchestration-scoped bearer
session and register the remote host. `t3 thread projects` returns both the
current environment and registered remotes. Agents pass the returned id through
`--environment`. Omitting that flag preserves the current host, project, and
provider defaults.

The CLI mapping is documented in `patches/desktop-thread-orchestration.md` and
the user guide. The dormant MCP toolkit stays compiled and tested, but the CLI
is the supported agent entrypoint.

The CLI includes compact passive observability commands:

- `t3 thread result` returns thread status, queue count, and latest messages
  without loading the full transcript.
- `t3 thread graph` returns automatic relationship edges without mutating the
  graph being inspected.

`t3 thread send` dispatches immediately by default. It starts an idle thread or steers a running
turn. Agents pass `--queue` only for follow-up work that should wait behind the active turn.
Automatic worker failure, approval-blocked, and user-input-blocked notifications use the same
immediate delivery path. Notifications from explicit orchestration waits also deliver immediately
when the watched condition resolves. Routine unwatched successful completion notifications remain
queued while a coordinator is running, and all notifications retain the normal idle-thread wake
behavior.

Full `t3 thread read` still records `readBy` activity when one thread reads
another. The compact `result` command is passive, so status checks do not add
relationship edges.

The patch routes Codex-backed `t3 thread fork` calls through Codex App Server.
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
history. The CLI and dormant MCP `fork_thread` paths also reject busy sources before
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
