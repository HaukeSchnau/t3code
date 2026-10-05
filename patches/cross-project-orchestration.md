# Cross-project orchestration

## Fork requirement

This fork has one user, and he wants an agent working in one project to read and steer his threads
in other projects. Upstream scopes every MCP thread tool to the calling thread's project, so a
thread id from another project fails with `thread_not_found` and search hides other projects.

## Behavior

- `t3_thread_read`, `t3_thread_send`, `t3_thread_wait`, `t3_thread_interrupt` and
  `t3_thread_update` accept a thread from any project. So do the thread toolkit tools that take a
  `threadId`: organize, configuration, transfers, the queue tools, the pending-request tools, and
  `t3_thread_send_attachments`.
- `t3_thread_list` takes an optional `projectId` from `t3_project_list`. It defaults to the
  caller's project, returns the project it listed, and rejects a project that does not exist.
- `t3_thread_search` returns matches from every project.
- Checks unrelated to project scope still run. These are the orchestration capability, the
  live-caller check for mutations, the rule that a target may not have broader runtime or
  interaction modes than the caller, hiding deleted threads, and refusing sends to archived ones.
- Delegation, `create_threads`, `t3_thread_fork` and merge-back still work inside the caller's
  project. Scheduled-task tools stay project-scoped.
- Clients need no change. A message sent across projects shows the usual "Sent by another agent"
  link, and thread routes carry no project.

## Implementation

`apps/server/src/mcp/crossProjectThreadManagement.ts` wraps `ThreadManagementService`. The methods
that take `{ projectId, threadId }` (`getProjectThreadRecords`, `getProjectThread`, `sendToThread`,
`waitForThread`, `interruptThread`) look up the thread's shell and substitute its own project. The
wrapped service's checks then pass for live threads and still reject deleted ones.
`listProjectThreads` asks `ProjectService` whether the project exists before listing.

`server.ts` provides the wrapper to `McpHttpServer.layer` and nowhere else. WebSocket handlers,
scheduled tasks and every other consumer resolve the plain service and keep upstream's scoping. Tests that compose the `McpHttpServer` registrations directly, such as
`OrchestratorMcpToolkit.integration.test.ts`, also see the plain service, so upstream's
foreign-project assertions there keep passing. `crossProjectThreadManagement.test.ts` covers the
fork behavior.

An unknown `projectId` fails `t3_thread_list` with `orchestration_error`, and the message names the
project. Upstream maps every listing failure to that code, and the wrapper can only raise the
service's existing error types.

## Upstream hooks

- `apps/server/src/server.ts` imports the wrapper and provides it to `McpHttpServer.layer`.
- `packages/contracts/src/orchestratorMcp.ts` adds the optional `projectId` to
  `OrchestratorMcpThreadListInput`.
- `apps/server/src/mcp/OrchestratorMcpService.ts` lists `input.projectId ?? parent.thread.projectId`
  in `listThreads` and returns that id.
- `apps/server/src/mcp/toolkits/thread/handlers.ts` drops the project filter from
  `t3_thread_search`.
- Description strings in `toolkits/orchestrator/tools.ts`, `toolkits/thread/tools.ts` and
  `toolkits/attachment/tools.ts`, plus the `threadId` annotation in
  `packages/contracts/src/threadMetadataMcp.ts`, say "any project" where upstream says "the calling
  project".

`docs/orchestration-v2/orchestrator-mcp-server.md` still describes upstream's project scoping. This
file overrides it for the fork.

After an upstream sync, look for new `ThreadManagementService` methods that take
`{ projectId, threadId }` and add them to the wrapper. An MCP tool that compares project ids itself,
as search did, needs its own hook.

## Removal

Drop this patch when upstream lets MCP tools reach threads outside the caller's project, either by
default or behind a setting.
