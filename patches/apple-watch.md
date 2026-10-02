# Apple Watch

## Fork requirement

Keep an eye on agents from an Apple Watch: see which threads need attention, read where an agent
stands, answer it, tell it what to do next, or stop it. Upstream has no watch support beyond
mirrored iPhone notifications and the Live Activity in the Smart Stack.

## Implementation

- The watch talks to T3 Code servers through the paired iPhone, which already holds the saved
  connections and reaches the tailnet. The watch never holds a credential of its own.
- `GET /api/orchestration/glance` lists one environment's threads for the watch: everything that
  needs the user or is working, plus finished threads from the last day that aren't settled,
  attention first. The phone asks every saved environment and merges the lists.
- `GET /api/orchestration/threads/:threadId/glance` summarizes one thread: a plain-text excerpt of
  the agent's latest message, the pending question when it is simple enough to answer on the
  watch, and whether a turn can be stopped. Both endpoints reuse the shared awareness projection
  and the reply planner's question parsing, so the watch, notifications and the Live Activity
  agree about a thread.
- Answers and follow-ups go through the thread reply endpoint described in
  [notification replies](notification-replies.md).

## Upstream maintenance

Drop this patch if upstream ships watch support with an equivalent server-side summary. The glance
endpoints are fork-owned additions to the orchestration HTTP group.
