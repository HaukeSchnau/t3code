// Fork: notification replies and the Apple Watch. See patches/notification-replies.md and
// patches/apple-watch.md.
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ThreadControl from "./ThreadControl.ts";

const notFound = {
  ThreadControlThreadNotFoundError: () => failEnvironmentNotFound("thread_not_found"),
};

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "threadControl",
  Effect.fnUntraced(function* (handlers) {
    const threadControl = yield* ThreadControl.ThreadControl;

    return handlers
      .handle(
        "reply",
        Effect.fn("environment.threadControl.reply")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* threadControl
            .reply({ threadId: args.params.threadId, ...args.payload })
            .pipe(
              Effect.catchTags(notFound),
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_dispatch_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "stop",
        Effect.fn("environment.threadControl.stop")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* threadControl.stop(args.params.threadId).pipe(
            Effect.catchTags(notFound),
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_dispatch_failed", cause),
            ),
          );
        }),
      )
      .handle(
        "glance",
        Effect.fn("environment.threadControl.glance")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* threadControl
            .listGlances()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "threadGlance",
        Effect.fn("environment.threadControl.threadGlance")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* threadControl.getGlance(args.params.threadId).pipe(
            Effect.catchTags(notFound),
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
            ),
          );
        }),
      );
  }),
);
