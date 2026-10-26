# Cross-project orchestration

## Fork requirement

This fork has one user, and his agents search his threads across every project. An agent working
in one project should find a related thread in another with one `t3_thread_search` call, without
first listing projects.

## Why upstream does not meet it

Upstream's MCP tools already reach any thread in the environment: read, send, wait, interrupt,
update, organize, the queue and pending-request tools, and `t3_thread_list` with a `projectId`.
Only `t3_thread_search` still narrows to one project. Without a `projectId` it keeps the calling
thread's project, and only a caller outside a T3 thread searches everything.

## Behavior

`t3_thread_search` without a `projectId` returns matches from every project, for every caller.
Each match names its `projectId`. With a `projectId`, it filters to that project as upstream does.

## Upstream hooks

- `apps/server/src/mcp/toolkits/thread/handlers.ts`: `t3_thread_search` passes its input to
  `ThreadSearch.searchThreads` unchanged. Upstream fills in the caller's `projectId` there.
- `apps/server/src/mcp/toolkits/thread/tools.ts`: the tool description says so.

`apps/server/src/mcp/toolkits/core.test.ts` ("searches every project unless the caller names one")
covers the behavior.

## Removal

Drop this patch when upstream searches every project by default, or when Hauke no longer needs
cross-project search in one call.
