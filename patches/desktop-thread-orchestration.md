# Dormant Desktop thread orchestration

T3 Code retains a Desktop-style orchestration toolkit, but the per-thread
`t3-code` MCP server does not register it. Provider sessions also omit the
`threads` capability. Agents therefore receive none of these tools:

- `list_projects`
- `list_thread_models`
- `create_thread`
- `list_threads`
- `read_thread`
- `read_thread_result`
- `await_thread`
- `get_thread_graph`
- `fork_thread`
- `send_message_to_thread`
- `set_thread_title`

The implementation stays in the repository so we can reconsider it later. Do
not expose individual tools from this list while the toolkit is dormant. A
future rollout should register the toolkit as one unit, restore the `threads`
credential capability, and restore provider instructions in the same change.

The dormant implementation maps the Codex Desktop App tool set to T3 Code's
event-sourced thread engine, project snapshot query, and managed thread
workspace service.

Thread relationship facts are recorded automatically as
`thread.activity.append` entries with kind
`thread-orchestration.relationship`. This currently captures create, fork,
read, message, and rename interactions for future graph/UI use. The toolkit
does not include graph-edit operations.

When enabled, the toolkit's boundary is the issued per-thread MCP credential,
not the project graph. A credential with the `threads` capability can list
projects and threads, then target any known thread id.

Codex-backed `fork_thread` calls now follow the official Codex fork semantics:
T3 Code asks Codex App Server to run `thread/fork`, imports the returned copied
history into the new T3 Code thread, binds that thread back to the forked Codex
provider thread, and records the `forkedFrom` relationship. Non-Codex source
threads still fall back to a related child thread without transcript cloning.
