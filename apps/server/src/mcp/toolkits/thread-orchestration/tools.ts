import {
  ThreadOrchestrationCreateThreadInput,
  ThreadOrchestrationCreateThreadResult,
  ThreadOrchestrationError,
  ThreadOrchestrationForkThreadInput,
  ThreadOrchestrationForkThreadResult,
  ThreadOrchestrationListProjectsResult,
  ThreadOrchestrationListThreadsInput,
  ThreadOrchestrationListThreadsResult,
  ThreadOrchestrationReadThreadInput,
  ThreadOrchestrationSendMessageInput,
  ThreadOrchestrationSendMessageResult,
  ThreadOrchestrationSetThreadTitleInput,
  ThreadOrchestrationThreadDetail,
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
      "List T3 Code projects that can host background agent threads. Use a returned projectId with create_thread.",
    success: ThreadOrchestrationListProjectsResult,
    failure: ThreadOrchestrationError,
    dependencies,
  }).annotate(Tool.Title, "List projects"),
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

export const CreateThreadTool = mutatingTool(
  Tool.make("create_thread", {
    description:
      "Create a T3 Code thread in a project and submit its first prompt. Use target.environment.type='local' for the project checkout or 'worktree' for an isolated managed workspace.",
    parameters: ThreadOrchestrationCreateThreadInput,
    success: ThreadOrchestrationCreateThreadResult,
    failure: ThreadOrchestrationError,
    dependencies,
  }).annotate(Tool.Title, "Create thread"),
);

export const ForkThreadTool = mutatingTool(
  Tool.make("fork_thread", {
    description:
      "Create a related child T3 Code thread from an existing thread or the calling thread. The current T3 implementation records the relationship but does not clone completed transcript history yet.",
    parameters: ThreadOrchestrationForkThreadInput,
    success: ThreadOrchestrationForkThreadResult,
    failure: ThreadOrchestrationError,
    dependencies,
  }).annotate(Tool.Title, "Fork thread"),
);

export const SendMessageToThreadTool = mutatingTool(
  Tool.make("send_message_to_thread", {
    description:
      "Send or queue a user message to another T3 Code thread. The target thread decides whether the turn starts immediately or waits behind active work.",
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
  ListProjectsTool,
  ListThreadsTool,
  ReadThreadTool,
  CreateThreadTool,
  ForkThreadTool,
  SendMessageToThreadTool,
  SetThreadTitleTool,
);
