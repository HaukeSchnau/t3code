import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as AgentWatches from "../../../watches/AgentWatches.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { WatchToolkit } from "./tools.ts";

const toFailure = (
  error:
    | AgentWatches.AgentWatchNotFoundError
    | AgentWatches.AgentWatchInputError
    | AgentWatches.AgentWatchDeniedError
    | AgentWatches.AgentWatchUnavailableError,
) => {
  switch (error._tag) {
    case "AgentWatchNotFoundError":
      return new OrchestratorMcpFailure({
        code:
          error.resource === "thread"
            ? "thread_not_found"
            : error.resource === "run"
              ? "run_not_found"
              : "invalid_request",
        message: error.message,
      });
    case "AgentWatchInputError":
      return new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });
    case "AgentWatchDeniedError":
      return new OrchestratorMcpFailure({ code: "capability_denied", message: error.message });
    case "AgentWatchUnavailableError":
      return new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });
  }
};

/** Watches wake the calling thread, so only an agent inside T3 Code can hold one. */
const callingThreadId = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (!scope.capabilities.has("orchestration")) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential cannot control threads.",
    });
  }
  const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "Watching");
  return thread.threadId;
});

const handlers = {
  t3_watch: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const watcherThreadId = yield* callingThreadId;
      const watches = yield* AgentWatches.AgentWatches;
      return yield* watches.create({ watcherThreadId, ...input }).pipe(Effect.mapError(toFailure));
    }),
  ),
  t3_watch_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const watcherThreadId = yield* callingThreadId;
      const watches = yield* AgentWatches.AgentWatches;
      return {
        watches: yield* watches
          .list({ watcherThreadId, includeClosed: input.includeClosed === true })
          .pipe(Effect.mapError(toFailure)),
      };
    }),
  ),
  t3_watch_cancel: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const watcherThreadId = yield* callingThreadId;
      const watches = yield* AgentWatches.AgentWatches;
      return yield* watches
        .cancel({ watcherThreadId, watchId: input.watchId })
        .pipe(Effect.mapError(toFailure));
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof WatchToolkit.tools>;

export const layer = McpToolAccess.toLayer(WatchToolkit, handlers);
