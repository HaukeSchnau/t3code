import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/unstable/ai";

import * as AgentWatches from "../../../watches/AgentWatches.ts";
import { readCaller, readMutationCaller } from "../../threadAccess.ts";
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

const WatchToolkitHandlersLive = WatchToolkit.toLayer({
  t3_watch: (input) =>
    Effect.gen(function* () {
      const { caller } = yield* readMutationCaller();
      const watches = yield* AgentWatches.AgentWatches;
      return yield* watches
        .create({ watcherThreadId: caller.id, ...input })
        .pipe(Effect.mapError(toFailure));
    }),
  t3_watch_list: (input) =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      const watches = yield* AgentWatches.AgentWatches;
      return {
        watches: yield* watches
          .list({ watcherThreadId: caller.id, includeClosed: input.includeClosed === true })
          .pipe(Effect.mapError(toFailure)),
      };
    }),
  t3_watch_cancel: (input) =>
    Effect.gen(function* () {
      const { caller } = yield* readMutationCaller();
      const watches = yield* AgentWatches.AgentWatches;
      return yield* watches
        .cancel({ watcherThreadId: caller.id, watchId: input.watchId })
        .pipe(Effect.mapError(toFailure));
    }),
});

export const WatchToolkitRegistrationLive = McpServer.toolkit(WatchToolkit).pipe(
  Layer.provide(WatchToolkitHandlersLive),
);
