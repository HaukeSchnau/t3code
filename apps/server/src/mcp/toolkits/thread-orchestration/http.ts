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
});

export const threadOrchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "threadOrchestration",
  Effect.fnUntraced(function* (handlers) {
    const service = yield* ThreadOrchestrationService;

    return handlers
      .handle(
        "listProjects",
        Effect.fn("environment.threadOrchestration.listProjects")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* service.listLocalProjects();
        }),
      )
      .handle(
        "listThreadModels",
        Effect.fn("environment.threadOrchestration.listThreadModels")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* service.listLocalThreadModels();
        }),
      )
      .handle(
        "listAllProjects",
        Effect.fn("environment.threadOrchestration.listAllProjects")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* service.listProjects();
        }),
      )
      .handle(
        "listAllThreadModels",
        Effect.fn("environment.threadOrchestration.listAllThreadModels")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* service.listThreadModels();
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
          return yield* service.createThreadFromRemote(
            scopeFromActor(args.payload.scope),
            args.payload.input,
          );
        }),
      )
      .handle(
        "createBatch",
        Effect.fn("environment.threadOrchestration.createBatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* service.createBatch(scopeFromActor(args.payload.scope), args.payload.input);
        }),
      )
      .handle(
        "readBatch",
        Effect.fn("environment.threadOrchestration.readBatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* service.readBatch(scopeFromActor(args.payload.scope), args.payload.input);
        }),
      )
      .handle(
        "cancelBatch",
        Effect.fn("environment.threadOrchestration.cancelBatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* service.cancelBatch(scopeFromActor(args.payload.scope), args.payload.input);
        }),
      )
      .handle(
        "cleanupBatch",
        Effect.fn("environment.threadOrchestration.cleanupBatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* service.cleanupBatch(
            scopeFromActor(args.payload.scope),
            args.payload.input,
          );
        }),
      )
      .handle(
        "createEffort",
        Effect.fn("environment.threadOrchestration.createEffort")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* service.createEffort(
            scopeFromActor(args.payload.scope),
            args.payload.input,
          );
        }),
      )
      .handle(
        "readEffort",
        Effect.fn("environment.threadOrchestration.readEffort")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* service.readEffort(scopeFromActor(args.payload.scope), args.payload.input);
        }),
      )
      .handle(
        "listEfforts",
        Effect.fn("environment.threadOrchestration.listEfforts")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* service.listEfforts(scopeFromActor(args.payload.scope), args.payload.input);
        }),
      )
      .handle(
        "renameEffort",
        Effect.fn("environment.threadOrchestration.renameEffort")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* service.renameEffort(
            scopeFromActor(args.payload.scope),
            args.payload.input,
          );
        }),
      )
      .handle(
        "closeEffort",
        Effect.fn("environment.threadOrchestration.closeEffort")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* service.closeEffort(scopeFromActor(args.payload.scope), args.payload.input);
        }),
      )
      .handle(
        "reopenEffort",
        Effect.fn("environment.threadOrchestration.reopenEffort")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* service.reopenEffort(
            scopeFromActor(args.payload.scope),
            args.payload.input,
          );
        }),
      )
      .handle(
        "addEffortMember",
        Effect.fn("environment.threadOrchestration.addEffortMember")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* service.addEffortMember(
            scopeFromActor(args.payload.scope),
            args.payload.input,
          );
        }),
      )
      .handle(
        "removeEffortMember",
        Effect.fn("environment.threadOrchestration.removeEffortMember")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* service.removeEffortMember(
            scopeFromActor(args.payload.scope),
            args.payload.input,
          );
        }),
      )
      .handle(
        "createWait",
        Effect.fn("environment.threadOrchestration.createWait")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* service.createWait(scopeFromActor(args.payload.scope), args.payload.input);
        }),
      )
      .handle(
        "readWait",
        Effect.fn("environment.threadOrchestration.readWait")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* service.readWait(scopeFromActor(args.payload.scope), args.payload.input);
        }),
      )
      .handle(
        "listWaits",
        Effect.fn("environment.threadOrchestration.listWaits")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* service.listWaits(scopeFromActor(args.payload.scope), args.payload.input);
        }),
      )
      .handle(
        "cancelWait",
        Effect.fn("environment.threadOrchestration.cancelWait")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* service.cancelWait(scopeFromActor(args.payload.scope), args.payload.input);
        }),
      )
      .handle(
        "createWatch",
        Effect.fn("environment.threadOrchestration.createWatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* service.createWatch(scopeFromActor(args.payload.scope), args.payload.input);
        }),
      )
      .handle(
        "readWatch",
        Effect.fn("environment.threadOrchestration.readWatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* service.readWatch(scopeFromActor(args.payload.scope), args.payload.input);
        }),
      )
      .handle(
        "listWatches",
        Effect.fn("environment.threadOrchestration.listWatches")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* service.listWatches(scopeFromActor(args.payload.scope), args.payload.input);
        }),
      )
      .handle(
        "cancelWatch",
        Effect.fn("environment.threadOrchestration.cancelWatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* service.cancelWatch(scopeFromActor(args.payload.scope), args.payload.input);
        }),
      )
      .handle(
        "stopThread",
        Effect.fn("environment.threadOrchestration.stopThread")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* service.stopThread(scopeFromActor(args.payload.scope), args.payload.input);
        }),
      )
      .handle(
        "forkThread",
        Effect.fn("environment.threadOrchestration.forkThread")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* service.forkThread(scopeFromActor(args.payload.scope), args.payload.input);
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
