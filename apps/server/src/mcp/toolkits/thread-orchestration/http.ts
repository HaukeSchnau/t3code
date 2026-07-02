import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type ThreadOrchestrationActorScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../../../auth/http.ts";
import type * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadOrchestrationService } from "./service.ts";

const scopeFromActor = (
  scope: ThreadOrchestrationActorScope,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: scope.environmentId,
  threadId: scope.threadId,
  providerSessionId: scope.providerSessionId,
  providerInstanceId: scope.providerInstanceId,
  capabilities: new Set(["threads"]),
  issuedAt: 0,
  expiresAt: Number.MAX_SAFE_INTEGER,
});

export const threadOrchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "threadOrchestration",
  Effect.fnUntraced(function* (handlers) {
    const service = yield* ThreadOrchestrationService;

    return handlers
      .handle(
        "listExecutionTargets",
        Effect.fn("environment.threadOrchestration.listExecutionTargets")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* service.listExecutionTargets();
        }),
      )
      .handle(
        "listThreads",
        Effect.fn("environment.threadOrchestration.listThreads")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* service.listThreads(scopeFromActor(args.payload.scope), args.payload.input);
        }),
      )
      .handle(
        "readThread",
        Effect.fn("environment.threadOrchestration.readThread")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* service.readThread(scopeFromActor(args.payload.scope), args.payload.input);
        }),
      )
      .handle(
        "readThreadResult",
        Effect.fn("environment.threadOrchestration.readThreadResult")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* service.readThreadResult(
            scopeFromActor(args.payload.scope),
            args.payload.input,
          );
        }),
      )
      .handle(
        "awaitThread",
        Effect.fn("environment.threadOrchestration.awaitThread")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* service.awaitThread(scopeFromActor(args.payload.scope), args.payload.input);
        }),
      )
      .handle(
        "getThreadGraph",
        Effect.fn("environment.threadOrchestration.getThreadGraph")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* service.getThreadGraph(
            scopeFromActor(args.payload.scope),
            args.payload.input,
          );
        }),
      )
      .handle(
        "createThread",
        Effect.fn("environment.threadOrchestration.createThread")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* service.createThread(
            scopeFromActor(args.payload.scope),
            args.payload.input,
          );
        }),
      )
      .handle(
        "sendMessageToThread",
        Effect.fn("environment.threadOrchestration.sendMessageToThread")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* service.sendMessageToThread(
            scopeFromActor(args.payload.scope),
            args.payload.input,
          );
        }),
      )
      .handle(
        "setThreadTitle",
        Effect.fn("environment.threadOrchestration.setThreadTitle")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* service.setThreadTitle(
            scopeFromActor(args.payload.scope),
            args.payload.input,
          );
        }),
      );
  }),
);
