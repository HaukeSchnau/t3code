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

The patch also adds a user-facing Codex fork action in the sidebar. Forking asks Codex App
Server to run `thread/fork`, then imports the returned forked thread into T3 Code using the
same transcript import path as Codex thread resume. This keeps transcript cloning semantics
owned by Codex App Server instead of reimplementing them in T3 Code.
