import {
  ThreadOrchestrationCreateThreadInput,
  ThreadOrchestrationCreateThreadResult,
  ThreadOrchestrationError,
  ThreadOrchestrationAwaitThreadInput,
  ThreadOrchestrationAwaitThreadResult,
  ThreadOrchestrationForkThreadInput,
  ThreadOrchestrationForkThreadResult,
  ThreadOrchestrationListExecutionTargetsResult,
  ThreadOrchestrationListProjectsResult,
  ThreadOrchestrationListThreadsInput,
  ThreadOrchestrationListThreadsResult,
  ThreadOrchestrationReadThreadInput,
  ThreadOrchestrationReadThreadResultInput,
  ThreadOrchestrationSendMessageInput,
  ThreadOrchestrationSendMessageResult,
  ThreadOrchestrationSetThreadTitleInput,
  ThreadOrchestrationThreadGraphInput,
  ThreadOrchestrationThreadGraphResult,
  ThreadOrchestrationThreadDetail,
  ThreadOrchestrationThreadResult,
  ThreadOrchestrationThreadSummary,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadOrchestrationService } from "./service.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, ThreadOrchestrationService];

const orchestrationTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, false) as T;

const mutatingTool = <T extends Tool.Any>(tool: T): T =>
  orchestrationTool(tool).annotate(Tool.Destructive, false) as T;

const readonlyTool = <T extends Tool.Any>(tool: T): T =>
  orchestrationTool(tool)
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, false) as T;

export const ListProjectsTool = readonlyTool(
  Tool.make("list_projects", {
    description:
      "List T3 Code projects in this execution environment that can host background agent threads. Use list_execution_targets first when choosing between providers/models.",
    success: ThreadOrchestrationListProjectsResult,
    failure: ThreadOrchestrationError,
    dependencies,
  }).annotate(Tool.Title, "List projects"),
);

export const ListExecutionTargetsTool = readonlyTool(
  Tool.make("list_execution_targets", {
    description:
      "List execution targets available to this T3 Code agent: host/environment identity, routability, projects, provider instances, and modelSelection values. Use this before create_thread when choosing Codex, Cursor, OpenCode, or another configured provider. A returned provider model's modelSelection can be passed directly to create_thread.modelSelection. remoteRouting='currentEnvironmentOnly' means this MCP server can create threads only on its own host; run from another connected environment to create threads there.",
    success: ThreadOrchestrationListExecutionTargetsResult,
    failure: ThreadOrchestrationError,
    dependencies,
  }).annotate(Tool.Title, "List execution targets"),
);

export const ListThreadsTool = readonlyTool(
  Tool.make("list_threads", {
    description:
      "List recent T3 Code threads available for orchestration. Optional query searches title, project, and workspace root; limit caps the number of returned summaries.",
    parameters: ThreadOrchestrationListThreadsInput,
    success: ThreadOrchestrationListThreadsResult,
    failure: ThreadOrchestrationError,
    dependencies,
  }).annotate(Tool.Title, "List threads"),
);

export const ReadThreadTool = orchestrationTool(
  Tool.make("read_thread", {
    description:
      "Read recent messages, activities, queued-message count, and status for a T3 Code thread. Reading another thread records an automatic relationship fact for the orchestration graph.",
    parameters: ThreadOrchestrationReadThreadInput,
    success: ThreadOrchestrationThreadDetail,
    failure: ThreadOrchestrationError,
    dependencies,
  })
    .annotate(Tool.Title, "Read thread")
    .annotate(Tool.Destructive, false),
);

export const ReadThreadResultTool = readonlyTool(
  Tool.make("read_thread_result", {
    description:
      "Read compact status, queue count, latest message, and latest assistant result for a T3 Code thread without loading the full transcript or recording a read relationship.",
    parameters: ThreadOrchestrationReadThreadResultInput,
    success: ThreadOrchestrationThreadResult,
    failure: ThreadOrchestrationError,
    dependencies,
  }).annotate(Tool.Title, "Read thread result"),
);

export const AwaitThreadTool = readonlyTool(
  Tool.make("await_thread", {
    description:
      "Wait for a T3 Code thread to become idle, complete its latest turn, or drain its queue, then return the same compact result shape as read_thread_result. This is passive and does not record a read relationship.",
    parameters: ThreadOrchestrationAwaitThreadInput,
    success: ThreadOrchestrationAwaitThreadResult,
    failure: ThreadOrchestrationError,
    dependencies,
  }).annotate(Tool.Title, "Await thread"),
);

export const GetThreadGraphTool = readonlyTool(
  Tool.make("get_thread_graph", {
    description:
      "Read the automatic relationship graph between T3 Code threads. Provide rootThreadId/depth for a bounded neighborhood. Read edges are excluded by default; set includeReadEdges=true when auditing inspection history.",
    parameters: ThreadOrchestrationThreadGraphInput,
    success: ThreadOrchestrationThreadGraphResult,
    failure: ThreadOrchestrationError,
    dependencies,
  }).annotate(Tool.Title, "Get thread graph"),
);

export const CreateThreadTool = mutatingTool(
  Tool.make("create_thread", {
    description:
      "Create a T3 Code thread in a project and submit its first prompt. Use target.environment.type='local' for the project checkout or 'worktree' for an isolated managed workspace. To choose a provider/model such as Codex, Cursor, or OpenCode, pass a modelSelection returned by list_execution_targets. Provider choice is normally a new-thread decision; later provider changes may be rejected once the target thread has a bound provider session.",
    parameters: ThreadOrchestrationCreateThreadInput,
    success: ThreadOrchestrationCreateThreadResult,
    failure: ThreadOrchestrationError,
    dependencies,
  }).annotate(Tool.Title, "Create thread"),
);

export const ForkThreadTool = mutatingTool(
  Tool.make("fork_thread", {
    description:
      "Create a related child T3 Code thread from an existing thread or the calling thread. Codex-backed source threads are forked through Codex App Server and include copied completed transcript history; unsupported sources fall back to a related empty thread.",
    parameters: ThreadOrchestrationForkThreadInput,
    success: ThreadOrchestrationForkThreadResult,
    failure: ThreadOrchestrationError,
    dependencies,
  }).annotate(Tool.Title, "Fork thread"),
);

export const SendMessageToThreadTool = mutatingTool(
  Tool.make("send_message_to_thread", {
    description:
      "Send or queue a user message to another T3 Code thread. The target thread decides whether the turn starts immediately or waits behind active work. modelSelection may request a model on the existing provider, but switching provider instances after a thread has started can be rejected; prefer create_thread for provider fanout.",
    parameters: ThreadOrchestrationSendMessageInput,
    success: ThreadOrchestrationSendMessageResult,
    failure: ThreadOrchestrationError,
    dependencies,
  }).annotate(Tool.Title, "Send message to thread"),
);

export const SetThreadTitleTool = mutatingTool(
  Tool.make("set_thread_title", {
    description:
      "Rename a T3 Code thread. Renaming another thread records an automatic relationship fact for the orchestration graph.",
    parameters: ThreadOrchestrationSetThreadTitleInput,
    success: ThreadOrchestrationThreadSummary,
    failure: ThreadOrchestrationError,
    dependencies,
  }).annotate(Tool.Title, "Set thread title"),
);

export const ThreadOrchestrationToolkit = Toolkit.make(
  ListExecutionTargetsTool,
  ListProjectsTool,
  ListThreadsTool,
  ReadThreadTool,
  ReadThreadResultTool,
  AwaitThreadTool,
  GetThreadGraphTool,
  CreateThreadTool,
  ForkThreadTool,
  SendMessageToThreadTool,
  SetThreadTitleTool,
);
