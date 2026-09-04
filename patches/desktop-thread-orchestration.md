# CLI thread orchestration

The per-thread `t3-code` MCP server does not register the Desktop-style
orchestration toolkit. Provider sessions also omit the `threads` capability.
The same operations are available through the running server and the
`t3 thread` CLI group:

- `list_projects` becomes `t3 thread projects`.
- `list_thread_models` becomes `t3 thread models`.
- `list_threads` becomes `t3 thread list`.
- `read_thread` becomes `t3 thread read`.
- `read_thread_result` becomes `t3 thread result`.
- `await_thread` becomes `t3 thread await`.
- `get_thread_graph` becomes `t3 thread graph`.
- `create_thread` becomes `t3 thread create`.
- `fork_thread` becomes `t3 thread fork`.
- `send_message_to_thread` becomes `t3 thread send`.
- `set_thread_title` becomes `t3 thread rename`.

Do not expose individual MCP tools from this list. A future MCP rollout should
register the toolkit as one unit and restore the `threads` credential
capability in the same change.

The implementation maps the Codex Desktop App operations to T3 Code's
event-sourced thread engine, project snapshot query, and managed thread
workspace service.

Provider processes receive `T3CODE_THREAD_ID`, so commands run by an agent can
inherit and record their caller. Direct shell use can pass `--from-thread`.
The CLI issues a short-lived administrative session and calls the running T3
server. It never opens live state directly.

Codex, Claude, and OpenCode receive the same concise orchestration instructions through their
native developer or system prompt channel. The instructions preserve the user's request separately
from coordinator context, give workers control over their approach, favor direct peer communication,
and make `wait create` followed by ending the coordinator turn the normal lifecycle. `await` remains
available for diagnostics but is not the recommended way to supervise workers. Cursor, Grok, and
Antigravity use ACP, which has no standard system-instruction field; T3 Code does not rewrite their
user prompts to emulate one.

`t3 thread send` dispatches immediately by default, steering a running turn through the same
provider path as the client queue's "Send now" action. `--queue` retains a durable follow-up until
active work completes successfully.

Thread relationship facts are recorded automatically as
`thread.activity.append` entries with kind
`thread-orchestration.relationship`. This currently captures create, fork,
read, message, and rename interactions for future graph/UI use. The toolkit
does not include graph-edit operations.

A fork records two independent graph facts. `createdBy` points from the calling thread to the new
thread, while `forkedFrom` points from the source thread to the new thread. A self-fork records both
edges with the same actor. Effort and label options travel in the fork request, so callers do not
need a follow-up membership repair.

The sidebar treats explicit effort membership as display ownership without rewriting graph lineage.
This handles older members that lack `createdBy` and cross-lineage members whose creator differs from
the effort coordinator. One thread still has one sidebar row: an open explicit effort membership wins
over creation lineage, with the first open membership as the stable tie-break for stale multi-effort
data. Closed membership is considered only when no open membership owns the row.

Web, desktop, and mobile project the resulting graph into the production thread list. Only lineage
roots with visible descendants receive a disclosure gutter; every actual thread keeps the full
production card and its lifecycle, pinning, rename, selection, and context actions. Root collapse is
recursive, nested containers remain independent, and a selected hidden descendant leaves a Viewing
row that reopens its precise container path. Search and the global Snoozed and Settled shelves stay
flat. The shared projection and its surface contract are documented in
`docs/internals/thread-orchestration-sidebar.md`.

The dormant MCP toolkit's boundary is the issued per-thread credential, not the
project graph. A credential with the `threads` capability can list projects and
threads, then target any known thread id.

Codex-backed `t3 thread fork` calls follow the official Codex fork semantics:
T3 Code asks Codex App Server to run `thread/fork`, imports the returned copied
history into the new T3 Code thread, binds that thread back to the forked Codex
provider thread, and records both relationships. Non-Codex source
threads still fall back to a related child thread without transcript cloning.
