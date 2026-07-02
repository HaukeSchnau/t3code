# Codex Thread Orchestration Tools

T3 Code exposes Desktop-style thread orchestration primitives to Codex-backed agents.

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

The patch also adds a user-facing Codex fork action in the sidebar and routes Codex-backed
agent `fork_thread` calls through Codex App Server. Forking asks Codex App Server to run
`thread/fork`, then imports the returned copied history into T3 Code and binds the new
T3 thread to the forked Codex provider thread. This keeps transcript cloning semantics owned
by Codex App Server instead of reimplementing them in T3 Code.

Assistant messages also expose a message-level "Fork from here" action. This is a UI affordance
over Codex App Server's `thread/fork.lastTurnId` parameter: T3 Code validates that the selected
message is a completed assistant message with a Codex turn id, passes that turn id to Codex, then
imports the terminal-prefix fork that Codex returns. The vendored `effect-codex-app-server`
schema is patched to include `thread/fork.lastTurnId`; otherwise its JSON-RPC request encoder
drops the field before it reaches Codex. For older installed Codex binaries that accept but ignore
`lastTurnId`, T3 Code rolls the newly forked provider thread back by the extra trailing turns before
importing and binding it. The sidebar/header fork remains a latest-thread fork because it omits
`lastTurnId`.
