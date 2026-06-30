# Desktop Thread Orchestration

T3 Code exposes a Desktop-style orchestration toolkit through the existing
per-thread `t3-code` MCP server. Provider sessions receive the `threads`
capability next to `preview`, which makes these tools available to agents:

- `list_projects`
- `create_thread`
- `list_threads`
- `read_thread`
- `fork_thread`
- `send_message_to_thread`
- `set_thread_title`

The implementation intentionally stays close to the Codex Desktop App tool
surface while mapping to T3 Code's own orchestration model. Tool calls use the
event-sourced thread engine, project snapshot query, and managed thread
workspace service instead of adding a separate workflow controller.

Thread relationship facts are recorded automatically as
`thread.activity.append` entries with kind
`thread-orchestration.relationship`. This currently captures create, fork,
read, message, and rename interactions for future graph/UI use without
exposing graph-edit operations to agents.

The first version intentionally grants the `threads` capability to provider
MCP credentials together with `preview`. A scoped T3 Code agent can list
projects/threads and target any known thread id; this matches the desired
Desktop-style orchestration power rather than a same-project-only subagent
boundary. The boundary is therefore the issued per-thread MCP credential, not
the project graph.

Known limitation: `fork_thread` creates a related child T3 Code thread and
records the `forkedFrom` relationship, but it does not yet clone completed
transcript history like Codex Desktop provider-level forks can.
