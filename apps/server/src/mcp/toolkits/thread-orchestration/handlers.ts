import * as Effect from "effect/Effect";
import { ThreadOrchestrationError } from "@t3tools/contracts";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadOrchestrationService } from "./service.ts";
import { ThreadOrchestrationToolkit } from "./tools.ts";

const requireThreadScope = McpInvocationContext.requireMcpCapability("threads").pipe(
  Effect.mapError(
    (cause) =>
      new ThreadOrchestrationError({
        operation: "capability",
        message: cause.message,
        threadId: cause.threadId,
      }),
  ),
);

const handlers = {
  list_thread_models: () =>
    requireThreadScope.pipe(
      Effect.flatMap(() =>
        ThreadOrchestrationService.pipe(
          Effect.flatMap((service) => service.listThreadModels()),
          Effect.map((result) => ({
            models: result.models.filter((model) => model.isLegacy !== true),
          })),
        ),
      ),
    ),
  list_projects: () =>
    requireThreadScope.pipe(
      Effect.flatMap(() =>
        ThreadOrchestrationService.pipe(Effect.flatMap((service) => service.listProjects())),
      ),
    ),
  list_threads: (input) =>
    requireThreadScope.pipe(
      Effect.flatMap((scope) =>
        ThreadOrchestrationService.pipe(
          Effect.flatMap((service) => service.listThreads(scope, input)),
        ),
      ),
    ),
  read_thread: (input) =>
    requireThreadScope.pipe(
      Effect.flatMap((scope) =>
        ThreadOrchestrationService.pipe(
          Effect.flatMap((service) => service.readThread(scope, input)),
        ),
      ),
    ),
  read_thread_result: (input) =>
    requireThreadScope.pipe(
      Effect.flatMap((scope) =>
        ThreadOrchestrationService.pipe(
          Effect.flatMap((service) => service.readThreadResult(scope, input)),
        ),
      ),
    ),
  get_thread_graph: (input) =>
    requireThreadScope.pipe(
      Effect.flatMap((scope) =>
        ThreadOrchestrationService.pipe(
          Effect.flatMap((service) => service.getThreadGraph(scope, input)),
        ),
      ),
    ),
  create_thread: (input) =>
    requireThreadScope.pipe(
      Effect.flatMap((scope) =>
        ThreadOrchestrationService.pipe(
          Effect.flatMap((service) => service.createThread(scope, input)),
        ),
      ),
    ),
  fork_thread: (input) =>
    requireThreadScope.pipe(
      Effect.flatMap((scope) =>
        ThreadOrchestrationService.pipe(
          Effect.flatMap((service) => service.forkThread(scope, input ?? {})),
        ),
      ),
    ),
  send_message_to_thread: (input) =>
    requireThreadScope.pipe(
      Effect.flatMap((scope) =>
        ThreadOrchestrationService.pipe(
          Effect.flatMap((service) => service.sendMessageToThread(scope, input)),
        ),
      ),
    ),
  set_thread_title: (input) =>
    requireThreadScope.pipe(
      Effect.flatMap((scope) =>
        ThreadOrchestrationService.pipe(
          Effect.flatMap((service) => service.setThreadTitle(scope, input)),
        ),
      ),
    ),
} satisfies Parameters<typeof ThreadOrchestrationToolkit.toLayer>[0];

export const ThreadOrchestrationToolkitHandlersLive = ThreadOrchestrationToolkit.toLayer(handlers);
