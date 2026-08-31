import {
  AuthAdministrativeScopes,
  EnvironmentHttpApi,
  EnvironmentId,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadOrchestrationBatchId,
  type ThreadOrchestrationActorScope,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

const THREAD_ID_ENV = "T3CODE_THREAD_ID";

class ThreadCliServerUnavailableError extends Data.TaggedError("ThreadCliServerUnavailableError")<{
  readonly statePath: string;
}> {
  override get message(): string {
    return "The T3 Code server is not running for this data directory.";
  }
}

class ThreadCliCallerRequiredError extends Data.TaggedError("ThreadCliCallerRequiredError")<{}> {
  override get message(): string {
    return `Pass --from-thread or run the command inside a T3 provider session with ${THREAD_ID_ENV} set.`;
  }
}

class ThreadCliModelSelectionError extends Data.TaggedError("ThreadCliModelSelectionError")<{}> {
  override get message(): string {
    return "Pass --provider-instance and --model together. --option also requires both flags.";
  }
}

class ThreadCliBatchWorkerError extends Data.TaggedError("ThreadCliBatchWorkerError")<{
  readonly label: string;
  readonly value: string;
}> {
  override get message(): string {
    return `Invalid --worker '${this.label}=${this.value}'. Use label=provider-instance/model?option:value.`;
  }
}

const makeClient = (origin: string) =>
  HttpApiClient.make(EnvironmentHttpApi, {
    baseUrl: origin,
  });

const withThreadCliSession = <A, E, R>(
  flags: CliAuthLocationFlags,
  run: (input: {
    readonly origin: string;
    readonly authorization: string;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return yield* new ThreadCliServerUnavailableError({
        statePath: config.serverRuntimeStatePath,
      });
    }

    return yield* Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      return yield* Effect.acquireUseRelease(
        auth.issueSession({
          scopes: AuthAdministrativeScopes,
          label: "t3 thread cli",
        }),
        (issued) =>
          run({
            origin: runtimeState.value.origin,
            authorization: `Bearer ${issued.token}`,
          }),
        (issued) => auth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
      );
    }).pipe(
      Effect.provide(
        EnvironmentAuth.runtimeLayer.pipe(
          Layer.provideMerge(FetchHttpClient.layer),
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
        ),
      ),
    );
  });

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit compact JSON."),
  Flag.withDefault(false),
);
const fromThreadFlag = Flag.string("from-thread").pipe(
  Flag.withDescription(`Calling thread id. Defaults to ${THREAD_ID_ENV}.`),
  Flag.optional,
);
const environmentFlag = Flag.string("environment").pipe(
  Flag.withDescription("Target environment id from `t3 thread projects`."),
  Flag.optional,
);
const providerInstanceFlag = Flag.string("provider-instance").pipe(
  Flag.withDescription("Provider instance id from `t3 thread models`."),
  Flag.optional,
);
const modelFlag = Flag.string("model").pipe(
  Flag.withDescription("Provider model slug from `t3 thread models`."),
  Flag.optional,
);
const modelOptionFlag = Flag.keyValuePair("option").pipe(
  Flag.withDescription("Provider option as key=value. Repeat for more options."),
  Flag.optional,
);
const runtimeModeFlag = Flag.choice("runtime-mode", [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const).pipe(Flag.withDescription("Override the thread runtime mode."), Flag.optional);
const interactionModeFlag = Flag.choice("interaction-mode", ["default", "plan"] as const).pipe(
  Flag.withDescription("Override the thread interaction mode."),
  Flag.optional,
);
const threadIdArgument = Argument.string("thread-id").pipe(
  Argument.withDescription("Target T3 thread id."),
);
const promptArgument = Argument.string("prompt").pipe(
  Argument.withDescription("Message to submit to the thread."),
);
const batchIdArgument = Argument.string("batch-id").pipe(
  Argument.withDescription("Orchestration batch id."),
);

const render = (value: unknown, compact: boolean) =>
  JSON.stringify(value, null, compact ? undefined : 2);

const currentCallerThreadId = (flag: Option.Option<string>): ThreadId | undefined => {
  const explicit = Option.getOrUndefined(flag)?.trim();
  const inherited = process.env[THREAD_ID_ENV]?.trim();
  const value = explicit || inherited;
  return value ? ThreadId.make(value) : undefined;
};

const modelSelectionFromFlags = (flags: {
  readonly providerInstance: Option.Option<string>;
  readonly model: Option.Option<string>;
  readonly modelOptions: Option.Option<Record<string, string>>;
}): Effect.Effect<ModelSelection | undefined, ThreadCliModelSelectionError> => {
  const providerInstance = Option.getOrUndefined(flags.providerInstance);
  const model = Option.getOrUndefined(flags.model);
  const rawOptions = Option.getOrUndefined(flags.modelOptions);
  if ((providerInstance === undefined) !== (model === undefined)) {
    return Effect.fail(new ThreadCliModelSelectionError());
  }
  if (providerInstance === undefined || model === undefined) {
    return rawOptions === undefined
      ? Effect.sync(() => undefined)
      : Effect.fail(new ThreadCliModelSelectionError());
  }
  const options = Object.entries(rawOptions ?? {}).map(([id, rawValue]) => ({
    id,
    value: rawValue === "true" ? true : rawValue === "false" ? false : rawValue,
  }));
  return Effect.succeed({
    instanceId: ProviderInstanceId.make(providerInstance),
    model,
    ...(options.length > 0 ? { options } : {}),
  });
};

const batchWorkerModelSelection = (
  label: string,
  value: string,
): Effect.Effect<ModelSelection, ThreadCliBatchWorkerError> => {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    return Effect.fail(new ThreadCliBatchWorkerError({ label, value }));
  }
  const instanceId = value.slice(0, separator);
  const modelAndOptions = value.slice(separator + 1);
  const querySeparator = modelAndOptions.indexOf("?");
  const model = querySeparator === -1 ? modelAndOptions : modelAndOptions.slice(0, querySeparator);
  if (!model) return Effect.fail(new ThreadCliBatchWorkerError({ label, value }));
  const query = querySeparator === -1 ? "" : modelAndOptions.slice(querySeparator + 1);
  return Effect.try({
    try: () =>
      query.length === 0
        ? []
        : query.split("&").map((entry) => {
            const optionSeparator = entry.indexOf(":");
            if (optionSeparator <= 0 || optionSeparator === entry.length - 1) {
              throw new Error("Invalid worker option");
            }
            const id = decodeURIComponent(entry.slice(0, optionSeparator));
            const rawValue = decodeURIComponent(entry.slice(optionSeparator + 1));
            return {
              id,
              value: rawValue === "true" ? true : rawValue === "false" ? false : rawValue,
            };
          }),
    catch: () => new ThreadCliBatchWorkerError({ label, value }),
  }).pipe(
    Effect.map((options) => ({
      instanceId: ProviderInstanceId.make(instanceId),
      model,
      ...(options.length > 0 ? { options } : {}),
    })),
  );
};

const actorScope = (
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ThreadOrchestrationActorScope => ({
  environmentId,
  threadId,
  providerSessionId: "t3-thread-cli",
  providerInstanceId: ProviderInstanceId.make("t3-cli"),
});

const withClientAndEnvironment = <A, E, R>(
  flags: CliAuthLocationFlags,
  run: (input: {
    readonly client: Effect.Success<ReturnType<typeof makeClient>>;
    readonly headers: { readonly authorization: string };
    readonly environmentId: EnvironmentId;
  }) => Effect.Effect<A, E, R>,
) =>
  withThreadCliSession(flags, ({ origin, authorization }) =>
    Effect.gen(function* () {
      const client = yield* makeClient(origin);
      const headers = { authorization } as const;
      const local = yield* client.threadOrchestration.listProjects({ headers });
      const environment = local.environments[0];
      if (!environment) {
        return yield* new ThreadCliServerUnavailableError({ statePath: origin });
      }
      return yield* run({ client, headers, environmentId: environment.environmentId });
    }),
  );

const commonFlags = {
  ...authLocationFlags,
  json: jsonFlag,
} as const;

const scopedFlags = {
  ...commonFlags,
  fromThread: fromThreadFlag,
  environment: environmentFlag,
} as const;

const projectsCommand = Command.make("projects", commonFlags).pipe(
  Command.withDescription("List local and registered remote projects."),
  Command.withHandler((flags) =>
    withThreadCliSession(flags, ({ origin, authorization }) =>
      Effect.gen(function* () {
        const client = yield* makeClient(origin);
        const result = yield* client.threadOrchestration.listAllProjects({
          headers: { authorization },
        });
        yield* Console.log(render(result, flags.json));
      }),
    ),
  ),
);

const modelsCommand = Command.make("models", commonFlags).pipe(
  Command.withDescription("List provider and model choices for new threads."),
  Command.withHandler((flags) =>
    withThreadCliSession(flags, ({ origin, authorization }) =>
      Effect.gen(function* () {
        const client = yield* makeClient(origin);
        const result = yield* client.threadOrchestration.listAllThreadModels({
          headers: { authorization },
        });
        yield* Console.log(render(result, flags.json));
      }),
    ),
  ),
);

const listCommand = Command.make("list", {
  ...scopedFlags,
  query: Flag.string("query").pipe(
    Flag.withDescription("Search titles and projects."),
    Flag.optional,
  ),
  limit: Flag.integer("limit").pipe(
    Flag.withDescription("Maximum number of threads."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("List recent threads."),
  Command.withHandler((flags) =>
    withClientAndEnvironment(flags, ({ client, headers, environmentId }) => {
      const caller = currentCallerThreadId(flags.fromThread) ?? ThreadId.make("t3-cli");
      return client.threadOrchestration
        .listThreads({
          headers,
          payload: {
            scope: actorScope(environmentId, caller),
            input: {
              ...(Option.isSome(flags.environment)
                ? { environmentId: EnvironmentId.make(flags.environment.value) }
                : {}),
              ...(Option.isSome(flags.query) ? { query: flags.query.value } : {}),
              ...(Option.isSome(flags.limit) ? { limit: flags.limit.value } : {}),
            },
          },
        })
        .pipe(Effect.tap((result) => Console.log(render(result, flags.json))));
    }),
  ),
);

const readCommand = Command.make("read", {
  ...scopedFlags,
  threadId: threadIdArgument,
  turns: Flag.integer("turns").pipe(
    Flag.withDescription("Limit the transcript to this many user turns."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Read a thread transcript and activities."),
  Command.withHandler((flags) =>
    withClientAndEnvironment(flags, ({ client, headers, environmentId }) => {
      const target = ThreadId.make(flags.threadId);
      const caller = currentCallerThreadId(flags.fromThread) ?? target;
      return client.threadOrchestration
        .readThread({
          headers,
          payload: {
            scope: actorScope(environmentId, caller),
            input: {
              threadId: target,
              ...(Option.isSome(flags.environment)
                ? { environmentId: EnvironmentId.make(flags.environment.value) }
                : {}),
              ...(Option.isSome(flags.turns) ? { turnLimit: flags.turns.value } : {}),
            },
          },
        })
        .pipe(Effect.tap((result) => Console.log(render(result, flags.json))));
    }),
  ),
);

const resultCommand = Command.make("result", {
  ...scopedFlags,
  threadId: threadIdArgument,
}).pipe(
  Command.withDescription("Read compact status and the latest assistant result."),
  Command.withHandler((flags) =>
    withClientAndEnvironment(flags, ({ client, headers, environmentId }) => {
      const target = ThreadId.make(flags.threadId);
      const caller = currentCallerThreadId(flags.fromThread) ?? target;
      return client.threadOrchestration
        .readThreadResult({
          headers,
          payload: {
            scope: actorScope(environmentId, caller),
            input: {
              threadId: target,
              ...(Option.isSome(flags.environment)
                ? { environmentId: EnvironmentId.make(flags.environment.value) }
                : {}),
            },
          },
        })
        .pipe(Effect.tap((result) => Console.log(render(result, flags.json))));
    }),
  ),
);

const awaitCommand = Command.make("await", {
  ...scopedFlags,
  threadId: threadIdArgument,
  until: Flag.choice("until", ["idle", "completed", "queue-drained"] as const).pipe(
    Flag.withDescription("Condition to wait for."),
    Flag.optional,
  ),
  timeoutMs: Flag.integer("timeout-ms").pipe(Flag.withDescription("Wait timeout."), Flag.optional),
  pollIntervalMs: Flag.integer("poll-interval-ms").pipe(
    Flag.withDescription("Polling interval."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Wait for a thread condition."),
  Command.withHandler((flags) =>
    withClientAndEnvironment(flags, ({ client, headers, environmentId }) => {
      const target = ThreadId.make(flags.threadId);
      const caller = currentCallerThreadId(flags.fromThread) ?? target;
      const until = Option.getOrUndefined(flags.until);
      return client.threadOrchestration
        .awaitThread({
          headers,
          payload: {
            scope: actorScope(environmentId, caller),
            input: {
              threadId: target,
              ...(Option.isSome(flags.environment)
                ? { environmentId: EnvironmentId.make(flags.environment.value) }
                : {}),
              ...(until !== undefined
                ? { until: until === "queue-drained" ? "queueDrained" : until }
                : {}),
              ...(Option.isSome(flags.timeoutMs) ? { timeoutMs: flags.timeoutMs.value } : {}),
              ...(Option.isSome(flags.pollIntervalMs)
                ? { pollIntervalMs: flags.pollIntervalMs.value }
                : {}),
            },
          },
        })
        .pipe(Effect.tap((result) => Console.log(render(result, flags.json))));
    }),
  ),
);

const graphCommand = Command.make("graph", {
  ...scopedFlags,
  rootThreadId: Argument.string("root-thread-id").pipe(
    Argument.withDescription("Optional thread at the center of the graph."),
    Argument.optional,
  ),
  includeReads: Flag.boolean("include-reads").pipe(
    Flag.withDescription("Include read relationships."),
    Flag.withDefault(false),
  ),
  depth: Flag.integer("depth").pipe(Flag.withDescription("Maximum graph depth."), Flag.optional),
  limit: Flag.integer("limit").pipe(
    Flag.withDescription("Maximum number of edges."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Read the automatic relationship graph."),
  Command.withHandler((flags) =>
    withClientAndEnvironment(flags, ({ client, headers, environmentId }) => {
      const caller = currentCallerThreadId(flags.fromThread) ?? ThreadId.make("t3-cli");
      return client.threadOrchestration
        .getThreadGraph({
          headers,
          payload: {
            scope: actorScope(environmentId, caller),
            input: {
              ...(Option.isSome(flags.environment)
                ? { environmentId: EnvironmentId.make(flags.environment.value) }
                : {}),
              ...(Option.isSome(flags.rootThreadId)
                ? { rootThreadId: ThreadId.make(flags.rootThreadId.value) }
                : {}),
              ...(flags.includeReads ? { includeReadEdges: true } : {}),
              ...(Option.isSome(flags.depth) ? { depth: flags.depth.value } : {}),
              ...(Option.isSome(flags.limit) ? { limit: flags.limit.value } : {}),
            },
          },
        })
        .pipe(Effect.tap((result) => Console.log(render(result, flags.json))));
    }),
  ),
);

const createCommand = Command.make("create", {
  ...scopedFlags,
  prompt: promptArgument,
  project: Flag.string("project").pipe(Flag.withDescription("Target project id."), Flag.optional),
  worktree: Flag.boolean("worktree").pipe(
    Flag.withDescription("Create an isolated managed workspace."),
    Flag.withDefault(false),
  ),
  providerInstance: providerInstanceFlag,
  model: modelFlag,
  modelOptions: modelOptionFlag,
  runtimeMode: runtimeModeFlag,
  interactionMode: interactionModeFlag,
  title: Flag.string("title").pipe(Flag.withDescription("Initial thread title."), Flag.optional),
}).pipe(
  Command.withDescription("Create a thread and submit its first prompt."),
  Command.withHandler((flags) =>
    withClientAndEnvironment(flags, ({ client, headers, environmentId }) =>
      Effect.gen(function* () {
        const caller = currentCallerThreadId(flags.fromThread);
        if (caller === undefined) {
          return yield* new ThreadCliCallerRequiredError();
        }
        const modelSelection = yield* modelSelectionFromFlags(flags);
        const hasTarget =
          Option.isSome(flags.environment) || Option.isSome(flags.project) || flags.worktree;
        const result = yield* client.threadOrchestration.createThread({
          headers,
          payload: {
            scope: actorScope(environmentId, caller),
            input: {
              prompt: flags.prompt,
              ...(hasTarget
                ? {
                    target: {
                      ...(Option.isSome(flags.environment)
                        ? { environmentId: EnvironmentId.make(flags.environment.value) }
                        : {}),
                      ...(Option.isSome(flags.project)
                        ? { projectId: ProjectId.make(flags.project.value) }
                        : {}),
                      ...(flags.worktree ? { environment: { type: "worktree" as const } } : {}),
                    },
                  }
                : {}),
              ...(modelSelection !== undefined ? { modelSelection } : {}),
              ...(Option.isSome(flags.runtimeMode) ? { runtimeMode: flags.runtimeMode.value } : {}),
              ...(Option.isSome(flags.interactionMode)
                ? { interactionMode: flags.interactionMode.value }
                : {}),
              ...(Option.isSome(flags.title) ? { title: flags.title.value } : {}),
            },
          },
        });
        yield* Console.log(render(result, flags.json));
      }),
    ),
  ),
);

const forkCommand = Command.make("fork", {
  ...commonFlags,
  fromThread: fromThreadFlag,
  threadId: threadIdArgument.pipe(Argument.optional),
  worktree: Flag.boolean("worktree").pipe(
    Flag.withDescription("Fork into an isolated managed workspace."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Fork an idle thread."),
  Command.withHandler((flags) =>
    withClientAndEnvironment(flags, ({ client, headers, environmentId }) =>
      Effect.gen(function* () {
        const source = Option.isSome(flags.threadId)
          ? ThreadId.make(flags.threadId.value)
          : currentCallerThreadId(flags.fromThread);
        if (source === undefined) {
          return yield* new ThreadCliCallerRequiredError();
        }
        const result = yield* client.threadOrchestration.forkThread({
          headers,
          payload: {
            scope: actorScope(environmentId, source),
            input: {
              threadId: source,
              environment: { type: flags.worktree ? "worktree" : "same-directory" },
            },
          },
        });
        yield* Console.log(render(result, flags.json));
      }),
    ),
  ),
);

const sendCommand = Command.make("send", {
  ...scopedFlags,
  threadId: threadIdArgument,
  prompt: promptArgument,
  providerInstance: providerInstanceFlag,
  model: modelFlag,
  modelOptions: modelOptionFlag,
  runtimeMode: runtimeModeFlag,
  interactionMode: interactionModeFlag,
}).pipe(
  Command.withDescription("Send or queue a message for another thread."),
  Command.withHandler((flags) =>
    withClientAndEnvironment(flags, ({ client, headers, environmentId }) =>
      Effect.gen(function* () {
        const target = ThreadId.make(flags.threadId);
        const caller = currentCallerThreadId(flags.fromThread) ?? target;
        const modelSelection = yield* modelSelectionFromFlags(flags);
        const result = yield* client.threadOrchestration.sendMessageToThread({
          headers,
          payload: {
            scope: actorScope(environmentId, caller),
            input: {
              threadId: target,
              prompt: flags.prompt,
              ...(Option.isSome(flags.environment)
                ? { environmentId: EnvironmentId.make(flags.environment.value) }
                : {}),
              ...(modelSelection !== undefined ? { modelSelection } : {}),
              ...(Option.isSome(flags.runtimeMode) ? { runtimeMode: flags.runtimeMode.value } : {}),
              ...(Option.isSome(flags.interactionMode)
                ? { interactionMode: flags.interactionMode.value }
                : {}),
            },
          },
        });
        yield* Console.log(render(result, flags.json));
      }),
    ),
  ),
);

const renameCommand = Command.make("rename", {
  ...scopedFlags,
  threadId: threadIdArgument,
  title: Argument.string("title").pipe(Argument.withDescription("New thread title.")),
}).pipe(
  Command.withDescription("Rename a thread."),
  Command.withHandler((flags) =>
    withClientAndEnvironment(flags, ({ client, headers, environmentId }) => {
      const target = ThreadId.make(flags.threadId);
      const caller = currentCallerThreadId(flags.fromThread) ?? target;
      return client.threadOrchestration
        .setThreadTitle({
          headers,
          payload: {
            scope: actorScope(environmentId, caller),
            input: {
              threadId: target,
              title: flags.title,
              ...(Option.isSome(flags.environment)
                ? { environmentId: EnvironmentId.make(flags.environment.value) }
                : {}),
            },
          },
        })
        .pipe(Effect.tap((result) => Console.log(render(result, flags.json))));
    }),
  ),
);

const batchCreateCommand = Command.make("create", {
  ...scopedFlags,
  prompt: promptArgument,
  workers: Flag.keyValuePair("worker").pipe(
    Flag.withDescription(
      "Worker as label=provider-instance/model?option:value. Repeat for multiple workers.",
    ),
  ),
  project: Flag.string("project").pipe(Flag.withDescription("Target project id."), Flag.optional),
  worktree: Flag.boolean("worktree").pipe(
    Flag.withDescription("Give each worker a managed workspace."),
    Flag.withDefault(false),
  ),
  runtimeMode: runtimeModeFlag,
  interactionMode: interactionModeFlag,
  title: Flag.string("title").pipe(Flag.withDescription("Batch title."), Flag.optional),
  timeoutMs: Flag.integer("timeout-ms").pipe(
    Flag.withDescription("Server-owned batch deadline."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Create a durable batch and launch all workers."),
  Command.withHandler((flags) =>
    withClientAndEnvironment(flags, ({ client, headers, environmentId }) =>
      Effect.gen(function* () {
        const caller = currentCallerThreadId(flags.fromThread);
        if (caller === undefined) return yield* new ThreadCliCallerRequiredError();
        const workers = yield* Effect.forEach(
          Object.entries(flags.workers),
          ([label, value]) =>
            batchWorkerModelSelection(label, value).pipe(
              Effect.map((modelSelection) => ({
                label,
                modelSelection,
                ...(Option.isSome(flags.runtimeMode)
                  ? { runtimeMode: flags.runtimeMode.value }
                  : {}),
                ...(Option.isSome(flags.interactionMode)
                  ? { interactionMode: flags.interactionMode.value }
                  : {}),
                ...(Option.isSome(flags.environment) ||
                Option.isSome(flags.project) ||
                flags.worktree
                  ? {
                      target: {
                        ...(Option.isSome(flags.environment)
                          ? { environmentId: EnvironmentId.make(flags.environment.value) }
                          : {}),
                        ...(Option.isSome(flags.project)
                          ? { projectId: ProjectId.make(flags.project.value) }
                          : {}),
                        ...(flags.worktree ? { environment: { type: "worktree" as const } } : {}),
                      },
                    }
                  : {}),
              })),
            ),
          { concurrency: "unbounded" },
        );
        const result = yield* client.threadOrchestration.createBatch({
          headers,
          payload: {
            scope: actorScope(environmentId, caller),
            input: {
              prompt: flags.prompt,
              workers,
              ...(Option.isSome(flags.title) ? { title: flags.title.value } : {}),
              ...(Option.isSome(flags.timeoutMs) ? { timeoutMs: flags.timeoutMs.value } : {}),
            },
          },
        });
        yield* Console.log(render(result, flags.json));
      }),
    ),
  ),
);

const batchReadCommand = Command.make("read", {
  ...scopedFlags,
  batchId: batchIdArgument,
}).pipe(
  Command.withDescription("Read a batch and every worker's honest outcome."),
  Command.withHandler((flags) =>
    withClientAndEnvironment(flags, ({ client, headers, environmentId }) =>
      Effect.gen(function* () {
        const caller = currentCallerThreadId(flags.fromThread) ?? ThreadId.make("t3-cli");
        const result = yield* client.threadOrchestration.readBatch({
          headers,
          payload: {
            scope: actorScope(environmentId, caller),
            input: { batchId: ThreadOrchestrationBatchId.make(flags.batchId) },
          },
        });
        yield* Console.log(render(result, flags.json));
      }),
    ),
  ),
);

const batchAwaitCommand = Command.make("await", {
  ...scopedFlags,
  batchId: batchIdArgument,
  timeoutMs: Flag.integer("timeout-ms").pipe(Flag.withDescription("Wait timeout."), Flag.optional),
}).pipe(
  Command.withDescription("Wait briefly for a batch; the server barrier keeps running afterward."),
  Command.withHandler((flags) =>
    withClientAndEnvironment(flags, ({ client, headers, environmentId }) =>
      Effect.gen(function* () {
        const caller = currentCallerThreadId(flags.fromThread) ?? ThreadId.make("t3-cli");
        const result = yield* client.threadOrchestration.awaitBatch({
          headers,
          payload: {
            scope: actorScope(environmentId, caller),
            input: {
              batchId: ThreadOrchestrationBatchId.make(flags.batchId),
              ...(Option.isSome(flags.timeoutMs) ? { timeoutMs: flags.timeoutMs.value } : {}),
            },
          },
        });
        yield* Console.log(render(result, flags.json));
      }),
    ),
  ),
);

const batchCancelCommand = Command.make("cancel", {
  ...scopedFlags,
  batchId: batchIdArgument,
}).pipe(
  Command.withDescription("Interrupt live local workers in a batch."),
  Command.withHandler((flags) =>
    withClientAndEnvironment(flags, ({ client, headers, environmentId }) =>
      Effect.gen(function* () {
        const caller = currentCallerThreadId(flags.fromThread) ?? ThreadId.make("t3-cli");
        const result = yield* client.threadOrchestration.cancelBatch({
          headers,
          payload: {
            scope: actorScope(environmentId, caller),
            input: { batchId: ThreadOrchestrationBatchId.make(flags.batchId) },
          },
        });
        yield* Console.log(render(result, flags.json));
      }),
    ),
  ),
);

const batchCleanupCommand = Command.make("cleanup", {
  ...scopedFlags,
  batchId: batchIdArgument,
}).pipe(
  Command.withDescription("Delete terminal local workers' managed workspaces."),
  Command.withHandler((flags) =>
    withClientAndEnvironment(flags, ({ client, headers, environmentId }) =>
      Effect.gen(function* () {
        const caller = currentCallerThreadId(flags.fromThread) ?? ThreadId.make("t3-cli");
        const result = yield* client.threadOrchestration.cleanupBatch({
          headers,
          payload: {
            scope: actorScope(environmentId, caller),
            input: { batchId: ThreadOrchestrationBatchId.make(flags.batchId) },
          },
        });
        yield* Console.log(render(result, flags.json));
      }),
    ),
  ),
);

const batchCommand = Command.make("batch").pipe(
  Command.withDescription("Create and manage durable orchestration batches."),
  Command.withSubcommands([
    batchCreateCommand,
    batchReadCommand,
    batchAwaitCommand,
    batchCancelCommand,
    batchCleanupCommand,
  ]),
);

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Inspect and control T3 Code threads."),
  Command.withSubcommands([
    projectsCommand,
    modelsCommand,
    listCommand,
    readCommand,
    resultCommand,
    awaitCommand,
    graphCommand,
    batchCommand,
    createCommand,
    forkCommand,
    sendCommand,
    renameCommand,
  ]),
);
