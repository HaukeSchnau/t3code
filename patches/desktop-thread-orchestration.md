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

Thread relationship facts are recorded automatically as
`thread.activity.append` entries with kind
`thread-orchestration.relationship`. This currently captures create, fork,
read, message, and rename interactions for future graph/UI use. The toolkit
does not include graph-edit operations.

The dormant MCP toolkit's boundary is the issued per-thread credential, not the
project graph. A credential with the `threads` capability can list projects and
threads, then target any known thread id.

Codex-backed `t3 thread fork` calls follow the official Codex fork semantics:
T3 Code asks Codex App Server to run `thread/fork`, imports the returned copied
history into the new T3 Code thread, binds that thread back to the forked Codex
provider thread, and records the `forkedFrom` relationship. Non-Codex source
threads still fall back to a related child thread without transcript cloning.
