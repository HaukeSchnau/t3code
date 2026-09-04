import {
  EnvironmentHttpApi,
  EnvironmentId,
  ThreadOrchestrationError,
  type ThreadOrchestrationActorScope,
  type ThreadOrchestrationCreateThreadInput,
  type ThreadOrchestrationCreateThreadResult,
  type ThreadOrchestrationListProjectsResult,
  type ThreadOrchestrationListThreadModelsResult,
  type ThreadOrchestrationListThreadsInput,
  type ThreadOrchestrationListThreadsResult,
  type ThreadOrchestrationReadThreadInput,
  type ThreadOrchestrationReadThreadResultInput,
  type ThreadOrchestrationSendMessageInput,
  type ThreadOrchestrationSendMessageResult,
  type ThreadOrchestrationSetThreadTitleInput,
  type ThreadOrchestrationThreadDetail,
  type ThreadOrchestrationThreadGraphInput,
  type ThreadOrchestrationThreadGraphResult,
  type ThreadOrchestrationThreadResult,
  type ThreadOrchestrationThreadSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import { RemoteEnvironmentRegistry } from "./RemoteEnvironmentRegistry.ts";

const REMOTE_THREAD_ORCHESTRATION_TIMEOUT = Duration.seconds(45);
const isThreadOrchestrationError = Schema.is(ThreadOrchestrationError);

export class RemoteThreadOrchestrationClient extends Context.Service<
  RemoteThreadOrchestrationClient,
  {
    readonly listProjects: () => Effect.Effect<
      ThreadOrchestrationListProjectsResult,
      ThreadOrchestrationError
    >;
    readonly listThreadModels: () => Effect.Effect<
      ThreadOrchestrationListThreadModelsResult,
      ThreadOrchestrationError
    >;
    readonly listThreads: (
      scope: ThreadOrchestrationActorScope,
      input: ThreadOrchestrationListThreadsInput,
    ) => Effect.Effect<ThreadOrchestrationListThreadsResult, ThreadOrchestrationError>;
    readonly readThread: (
      scope: ThreadOrchestrationActorScope,
      input: ThreadOrchestrationReadThreadInput,
    ) => Effect.Effect<ThreadOrchestrationThreadDetail, ThreadOrchestrationError>;
    readonly readThreadResult: (
      scope: ThreadOrchestrationActorScope,
      input: ThreadOrchestrationReadThreadResultInput,
    ) => Effect.Effect<ThreadOrchestrationThreadResult, ThreadOrchestrationError>;
    readonly getThreadGraph: (
      scope: ThreadOrchestrationActorScope,
      input: ThreadOrchestrationThreadGraphInput,
    ) => Effect.Effect<ThreadOrchestrationThreadGraphResult, ThreadOrchestrationError>;
    readonly createThread: (
      scope: ThreadOrchestrationActorScope,
      input: ThreadOrchestrationCreateThreadInput,
    ) => Effect.Effect<ThreadOrchestrationCreateThreadResult, ThreadOrchestrationError>;
    readonly createRootThread: (
      input: ThreadOrchestrationCreateThreadInput,
    ) => Effect.Effect<ThreadOrchestrationCreateThreadResult, ThreadOrchestrationError>;
    readonly sendMessageToThread: (
      scope: ThreadOrchestrationActorScope,
      input: ThreadOrchestrationSendMessageInput,
    ) => Effect.Effect<ThreadOrchestrationSendMessageResult, ThreadOrchestrationError>;
    readonly setThreadTitle: (
      scope: ThreadOrchestrationActorScope,
      input: ThreadOrchestrationSetThreadTitleInput,
    ) => Effect.Effect<ThreadOrchestrationThreadSummary, ThreadOrchestrationError>;
  }
>()("t3/mcp/toolkits/thread-orchestration/RemoteThreadOrchestrationClient") {}

const toThreadOrchestrationError =
  (operation: string, environmentId?: EnvironmentId) =>
  (cause: unknown): ThreadOrchestrationError => {
    if (isThreadOrchestrationError(cause)) {
      return cause;
    }
    return new ThreadOrchestrationError({
      operation,
      code: "remote_request_failed",
      message: `Remote thread orchestration operation '${operation}' failed.`,
      ...(environmentId !== undefined ? { environmentId } : {}),
      cause,
    });
  };

const make = Effect.gen(function* () {
  const registry = yield* RemoteEnvironmentRegistry;

  const withTarget = <A>(
    operation: string,
    environmentId: EnvironmentId,
    run: (input: {
      readonly baseUrl: string;
      readonly authorization: string;
    }) => Effect.Effect<A, ThreadOrchestrationError>,
  ): Effect.Effect<A, ThreadOrchestrationError> =>
    Effect.gen(function* () {
      const environment = yield* registry
        .get(environmentId)
        .pipe(Effect.mapError(toThreadOrchestrationError(operation, environmentId)));
      if (Option.isNone(environment)) {
        return yield* new ThreadOrchestrationError({
          operation,
          code: "remote_environment_not_found",
          message: `Remote environment '${environmentId}' is not registered for orchestration.`,
          environmentId,
          resourceType: "environment",
          resourceId: environmentId,
        });
      }
      const token = yield* registry
        .getBearerToken(environmentId)
        .pipe(Effect.mapError(toThreadOrchestrationError(operation, environmentId)));
      if (Option.isNone(token)) {
        return yield* new ThreadOrchestrationError({
          operation,
          code: "remote_environment_token_missing",
          message: `Remote environment '${environmentId}' has no orchestration bearer token.`,
          environmentId,
          resourceType: "environment",
          resourceId: environmentId,
        });
      }
      return yield* run({
        baseUrl: environment.value.httpBaseUrl,
        authorization: `Bearer ${token.value}`,
      }).pipe(
        Effect.timeout(REMOTE_THREAD_ORCHESTRATION_TIMEOUT),
        Effect.mapError(toThreadOrchestrationError(operation, environmentId)),
      );
    });

  const remoteClient = (baseUrl: string) =>
    HttpApiClient.make(EnvironmentHttpApi, {
      baseUrl,
    });

  const listProjects = () =>
    Effect.gen(function* () {
      const environments = yield* registry
        .list()
        .pipe(
          Effect.mapError((cause) =>
            toThreadOrchestrationError("list_projects.remote_registry")(cause),
          ),
        );
      const results = yield* Effect.forEach(
        environments,
        (environment) =>
          withTarget(
            "list_projects.remote",
            environment.environmentId,
            ({ baseUrl, authorization }) =>
              Effect.gen(function* () {
                const client = yield* remoteClient(baseUrl);
                return yield* client.threadOrchestration.listProjects({
                  headers: { authorization },
                });
              }).pipe(
                Effect.provide(FetchHttpClient.layer),
                Effect.mapError(
                  toThreadOrchestrationError("list_projects.remote", environment.environmentId),
                ),
              ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Remote project discovery failed.", {
                environmentId: environment.environmentId,
                cause,
              }).pipe(Effect.as({ environments: [] })),
            ),
          ),
        { concurrency: 4 },
      );
      return {
        environments: results.flatMap((result) =>
          result.environments
            .filter((target) =>
              environments.some(
                (environment) => environment.environmentId === target.environmentId,
              ),
            )
            .map((target) => ({
              ...target,
              remoteRouting: "registeredRemote" as const,
            })),
        ),
      };
    });

  const listThreadModels = () =>
    Effect.gen(function* () {
      const environments = yield* registry
        .list()
        .pipe(
          Effect.mapError((cause) =>
            toThreadOrchestrationError("list_thread_models.remote_registry")(cause),
          ),
        );
      const results = yield* Effect.forEach(
        environments,
        (environment) =>
          withTarget(
            "list_thread_models.remote",
            environment.environmentId,
            ({ baseUrl, authorization }) =>
              Effect.gen(function* () {
                const client = yield* remoteClient(baseUrl);
                return yield* client.threadOrchestration.listThreadModels({
                  headers: { authorization },
                });
              }).pipe(
                Effect.provide(FetchHttpClient.layer),
                Effect.mapError(
                  toThreadOrchestrationError(
                    "list_thread_models.remote",
                    environment.environmentId,
                  ),
                ),
              ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Remote thread model discovery failed.", {
                environmentId: environment.environmentId,
                cause,
              }).pipe(Effect.as({ models: [] })),
            ),
          ),
        { concurrency: 4 },
      );
      return {
        models: results.flatMap((result) =>
          result.models.filter((model) =>
            environments.some((environment) => environment.environmentId === model.environmentId),
          ),
        ),
      };
    });

  const listThreads = (
    scope: ThreadOrchestrationActorScope,
    input: ThreadOrchestrationListThreadsInput,
  ) =>
    withTarget("list_threads.remote", input.environmentId!, ({ baseUrl, authorization }) =>
      Effect.gen(function* () {
        const client = yield* remoteClient(baseUrl);
        return yield* client.threadOrchestration.listThreads({
          headers: { authorization },
          payload: { scope, input },
        });
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.mapError(toThreadOrchestrationError("list_threads.remote", input.environmentId)),
      ),
    );

  const readThread = (
    scope: ThreadOrchestrationActorScope,
    input: ThreadOrchestrationReadThreadInput,
  ) =>
    withTarget("read_thread.remote", input.environmentId!, ({ baseUrl, authorization }) =>
      Effect.gen(function* () {
        const client = yield* remoteClient(baseUrl);
        return yield* client.threadOrchestration.readThread({
          headers: { authorization },
          payload: { scope, input },
        });
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.mapError(toThreadOrchestrationError("read_thread.remote", input.environmentId)),
      ),
    );

  const readThreadResult = (
    scope: ThreadOrchestrationActorScope,
    input: ThreadOrchestrationReadThreadResultInput,
  ) =>
    withTarget("read_thread_result.remote", input.environmentId!, ({ baseUrl, authorization }) =>
      Effect.gen(function* () {
        const client = yield* remoteClient(baseUrl);
        return yield* client.threadOrchestration.readThreadResult({
          headers: { authorization },
          payload: { scope, input },
        });
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.mapError(
          toThreadOrchestrationError("read_thread_result.remote", input.environmentId),
        ),
      ),
    );

  const getThreadGraph = (
    scope: ThreadOrchestrationActorScope,
    input: ThreadOrchestrationThreadGraphInput,
  ) =>
    withTarget("get_thread_graph.remote", input.environmentId!, ({ baseUrl, authorization }) =>
      Effect.gen(function* () {
        const client = yield* remoteClient(baseUrl);
        return yield* client.threadOrchestration.getThreadGraph({
          headers: { authorization },
          payload: { scope, input },
        });
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.mapError(toThreadOrchestrationError("get_thread_graph.remote", input.environmentId)),
      ),
    );

  const createThread = (
    scope: ThreadOrchestrationActorScope,
    input: ThreadOrchestrationCreateThreadInput,
  ) =>
    withTarget("create_thread.remote", input.target!.environmentId!, ({ baseUrl, authorization }) =>
      Effect.gen(function* () {
        const client = yield* remoteClient(baseUrl);
        return yield* client.threadOrchestration.createThread({
          headers: { authorization },
          payload: {
            scope,
            input: {
              ...input,
              target: input.target ? { ...input.target, environmentId: undefined } : undefined,
            },
          },
        });
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.mapError(
          toThreadOrchestrationError("create_thread.remote", input.target?.environmentId),
        ),
      ),
    );

  const createRootThread = (input: ThreadOrchestrationCreateThreadInput) =>
    withTarget(
      "create_root_thread.remote",
      input.target!.environmentId!,
      ({ baseUrl, authorization }) =>
        Effect.gen(function* () {
          const client = yield* remoteClient(baseUrl);
          return yield* client.threadOrchestration.createRootThread({
            headers: { authorization },
            payload: {
              input: {
                ...input,
                target: input.target ? { ...input.target, environmentId: undefined } : undefined,
              },
            },
          });
        }).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.mapError(
            toThreadOrchestrationError("create_root_thread.remote", input.target?.environmentId),
          ),
        ),
    );

  const sendMessageToThread = (
    scope: ThreadOrchestrationActorScope,
    input: ThreadOrchestrationSendMessageInput,
  ) =>
    withTarget(
      "send_message_to_thread.remote",
      input.environmentId!,
      ({ baseUrl, authorization }) =>
        Effect.gen(function* () {
          const client = yield* remoteClient(baseUrl);
          return yield* client.threadOrchestration.sendMessageToThread({
            headers: { authorization },
            payload: { scope, input },
          });
        }).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.mapError(
            toThreadOrchestrationError("send_message_to_thread.remote", input.environmentId),
          ),
        ),
    );

  const setThreadTitle = (
    scope: ThreadOrchestrationActorScope,
    input: ThreadOrchestrationSetThreadTitleInput,
  ) =>
    withTarget("set_thread_title.remote", input.environmentId!, ({ baseUrl, authorization }) =>
      Effect.gen(function* () {
        const client = yield* remoteClient(baseUrl);
        return yield* client.threadOrchestration.setThreadTitle({
          headers: { authorization },
          payload: { scope, input },
        });
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.mapError(toThreadOrchestrationError("set_thread_title.remote", input.environmentId)),
      ),
    );

  return RemoteThreadOrchestrationClient.of({
    listProjects,
    listThreadModels,
    listThreads,
    readThread,
    readThreadResult,
    getThreadGraph,
    createThread,
    createRootThread,
    sendMessageToThread,
    setThreadTitle,
  });
});

export const layer = Layer.effect(RemoteThreadOrchestrationClient, make);
