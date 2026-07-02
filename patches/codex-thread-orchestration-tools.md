# Codex Thread Orchestration Tools

T3 Code exposes Desktop-style thread orchestration primitives to Codex-backed agents.

The patch exposes `list_execution_targets` as the discovery entrypoint for
orchestrators. It returns the current environment descriptor, host id, routability
state, projects, provider instances, models, model capabilities, and exact
`modelSelection` objects that can be passed to `create_thread.modelSelection`.
This lets agents fan out across configured providers such as Codex, Cursor, and
OpenCode without guessing provider instance ids or model slugs.
For the common case, `create_thread` can omit both `target` and `modelSelection`;
it defaults to a sibling thread in the calling thread's current project, current
environment, and current provider/model. Supplying
`target.environment.type: "worktree"` or an explicit `modelSelection` is reserved for intentional
isolation or provider/model fanout.

Remote host orchestration is represented explicitly through `environmentId`.
The local T3 server owns a backend-to-backend remote orchestration registry,
persisting non-secret remote metadata in `remote-orchestration-environments.json`
and storing bearer access tokens in `ServerSecretStore`. `t3 remote register`
can exchange a one-time remote pairing token for an orchestration-scoped bearer
session and register the remote host. `list_execution_targets` returns both the
current environment and registered remotes; agents pass the returned
`environment.environmentId` to the existing thread tools rather than using a
separate remote-only tool family. Omitting `environmentId` preserves the current
host/current project/current provider defaults.

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
