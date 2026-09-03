import {
  ThreadOrchestrationCreateThreadInput,
  ThreadOrchestrationCreateThreadResult,
  ThreadOrchestrationError,
  ThreadOrchestrationAwaitThreadInput,
  ThreadOrchestrationAwaitThreadResult,
  ThreadOrchestrationForkThreadInput,
  ThreadOrchestrationForkThreadResult,
  ThreadOrchestrationListProjectsResult,
  ThreadOrchestrationListThreadModelsResult,
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
      "List local and registered remote environments plus their projects for durable T3 Code thread orchestration. Use a returned environmentId with create_thread.target.environmentId, list_threads.environmentId, read_thread.environmentId, await_thread.environmentId, send_message_to_thread.environmentId, set_thread_title.environmentId, or get_thread_graph.environmentId. This is the normal discovery tool before creating threads in another project or on another host.",
    success: ThreadOrchestrationListProjectsResult,
    failure: ThreadOrchestrationError,
    dependencies,
  }).annotate(Tool.Title, "List projects"),
);

export const ListThreadModelsTool = readonlyTool(
  Tool.make("list_thread_models", {
    description:
      "List current provider/model choices and exact modelSelection values for creating T3 Code threads. Most agents should not call this for ordinary child threads: omit create_thread.modelSelection to inherit the current provider, model, and reasoning/options. Use this only when the user asks for a specific provider/model or when intentionally doing provider/model fanout such as comparing Codex, Cursor, and OpenCode. When using a model choice from another environment, also pass that choice's environmentId as create_thread.target.environmentId. Reasoning metadata is advisory; omit modelSelection options to use the listed model's default reasoning, or include a supported option only when intentionally overriding.",
    success: ThreadOrchestrationListThreadModelsResult,
    failure: ThreadOrchestrationError,
    dependencies,
  }).annotate(Tool.Title, "List thread models"),
);

export const ListThreadsTool = readonlyTool(
  Tool.make("list_threads", {
    description:
      "List recent T3 Code threads available for orchestration. Omit environmentId for the current host, or pass an environmentId returned by list_projects to list threads on a registered remote host. Optional query searches title, project, and workspace root; limit caps the number of returned summaries.",
    parameters: ThreadOrchestrationListThreadsInput,
    success: ThreadOrchestrationListThreadsResult,
    failure: ThreadOrchestrationError,
    dependencies,
  }).annotate(Tool.Title, "List threads"),
);

export const ReadThreadTool = orchestrationTool(
  Tool.make("read_thread", {
    description:
      "Read recent messages, activities, queued-message count, and status for a T3 Code thread. Omit environmentId for the current host, or pass the target thread's environmentId for a registered remote host. Reading another thread records an automatic relationship fact for the orchestration graph.",
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
      "Read compact status, queue count, latest message, latest assistant result, and any typed failure for a T3 Code thread without loading the full transcript or recording a read relationship. A provider_unavailable failure is scoped beyond the thread: do not immediately retry its provider instance; wait until retryAt or choose another provider/model. Pass environmentId to read a registered remote host.",
    parameters: ThreadOrchestrationReadThreadResultInput,
    success: ThreadOrchestrationThreadResult,
    failure: ThreadOrchestrationError,
    dependencies,
  }).annotate(Tool.Title, "Read thread result"),
);

export const AwaitThreadTool = readonlyTool(
  Tool.make("await_thread", {
    description:
      "Wait for a T3 Code thread to become idle, complete its latest turn, or drain its queue, then return the same compact result shape as read_thread_result, including any typed failure. A provider_unavailable failure means an immediate retry on that provider instance is pointless; wait until retryAt or choose another provider/model. This is passive and does not record a read relationship. Pass environmentId to wait on a registered remote host.",
    parameters: ThreadOrchestrationAwaitThreadInput,
    success: ThreadOrchestrationAwaitThreadResult,
    failure: ThreadOrchestrationError,
    dependencies,
  }).annotate(Tool.Title, "Await thread"),
);

export const GetThreadGraphTool = readonlyTool(
  Tool.make("get_thread_graph", {
    description:
      "Read the automatic relationship graph between T3 Code threads in one environment. Omit environmentId for the current host, or pass a registered remote environmentId. Provide rootThreadId/depth for a bounded neighborhood. Read edges are excluded by default; set includeReadEdges=true when auditing inspection history.",
    parameters: ThreadOrchestrationThreadGraphInput,
    success: ThreadOrchestrationThreadGraphResult,
    failure: ThreadOrchestrationError,
    dependencies,
  }).annotate(Tool.Title, "Get thread graph"),
);

export const CreateThreadTool = mutatingTool(
  Tool.make("create_thread", {
    description:
      "Create a durable T3 Code thread and submit its first prompt. By default this creates a sibling thread in the calling thread's current project, current host, and current provider/model/options, runtime mode, and interaction mode. Do not specify modelSelection unless the user explicitly requests a provider/model or you are deliberately doing provider/model fanout; otherwise omit it so the child inherits the current model and reasoning/options. Legacy models are rejected, including inherited legacy models. Set allowLegacyModel=true only for an intentional compatibility run. Set target.environmentId from list_projects to create on a registered remote host, target.projectId for another project, or target.environment.type='worktree' for an isolated managed workspace on that host. Use list_thread_models only when intentionally choosing another provider/model such as Codex, Cursor, or OpenCode.",
    parameters: ThreadOrchestrationCreateThreadInput,
    success: ThreadOrchestrationCreateThreadResult,
    failure: ThreadOrchestrationError,
    dependencies,
  }).annotate(Tool.Title, "Create thread"),
);

export const ForkThreadTool = mutatingTool(
  Tool.make("fork_thread", {
    description:
      "Fork a T3 Code thread. Omit threadId to fork the calling thread, or pass threadId to fork a specific source while preserving the caller as creator. Omit environment for a same-directory fork, or pass environment.type='worktree' for an isolated managed workspace. Set coordination.effortId and coordination.label to create the fork as an effort member in the same operation; set excludeInheritedEffort to opt out of the caller's sole open effort. Codex-backed source threads are forked through Codex App Server and include copied completed transcript history only; active unfinished turns are not copied. If transcriptCloned is false, the child is a related empty thread and any needed context must be sent explicitly.",
    parameters: ThreadOrchestrationForkThreadInput,
    success: ThreadOrchestrationForkThreadResult,
    failure: ThreadOrchestrationError,
    dependencies,
  }).annotate(Tool.Title, "Fork thread"),
);

export const SendMessageToThreadTool = mutatingTool(
  Tool.make("send_message_to_thread", {
    description:
      "Send a user message to another T3 Code thread. Delivery defaults to immediate: an idle thread starts and a running turn is steered. Set delivery='queued' only when the recipient should finish its current turn first. Omit environmentId for the current host, or pass the target thread's environmentId for a registered remote host. Omit modelSelection, runtimeMode, and interactionMode to keep the target thread's current settings. A model-changing send rejects legacy models unless allowLegacyModel=true. Do not use this to switch providers; create a new thread for provider/model fanout.",
    parameters: ThreadOrchestrationSendMessageInput,
    success: ThreadOrchestrationSendMessageResult,
    failure: ThreadOrchestrationError,
    dependencies,
  }).annotate(Tool.Title, "Send message to thread"),
);

export const SetThreadTitleTool = mutatingTool(
  Tool.make("set_thread_title", {
    description:
      "Rename a T3 Code thread. Omit environmentId for the current host, or pass the target thread's environmentId for a registered remote host. Renaming another thread records an automatic relationship fact for the orchestration graph.",
    parameters: ThreadOrchestrationSetThreadTitleInput,
    success: ThreadOrchestrationThreadSummary,
    failure: ThreadOrchestrationError,
    dependencies,
  }).annotate(Tool.Title, "Set thread title"),
);

export const ThreadOrchestrationToolkit = Toolkit.make(
  ListProjectsTool,
  ListThreadModelsTool,
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
