import {
  CodexSettings,
  CommandId,
  ProviderDriverKind,
  ThreadId,
  ThreadOrchestrationError,
  type TurnId,
  defaultInstanceIdForDriver,
  type OrchestrationProject,
  type OrchestrationThread,
  type ThreadOrchestrationThreadSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../../../config.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import {
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "../../../provider/Drivers/CodexHomeLayout.ts";
import {
  codexThreadMessages,
  forkCodexProviderThread,
} from "../../../provider/CodexThreadBridge.ts";
import { mergeProviderInstanceEnvironment } from "../../../provider/ProviderInstanceEnvironment.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { ProviderSessionDirectory } from "../../../provider/Services/ProviderSessionDirectory.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import type { PreparedThreadWorkspace } from "../../../workspace/ThreadWorkspaceService.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const DEFAULT_CODEX_INSTANCE_ID = defaultInstanceIdForDriver(CODEX_DRIVER);
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);

export interface CodexThreadForkImportInput {
  readonly threadId: ThreadId;
  readonly sourceThread: Pick<
    OrchestrationThread,
    | "id"
    | "modelSelection"
    | "runtimeMode"
    | "interactionMode"
    | "branch"
    | "worktreePath"
    | "workspaceId"
  >;
  readonly project: Pick<OrchestrationProject, "id" | "title" | "workspaceRoot">;
  readonly title: string;
  readonly createdAt: string;
  readonly preparedWorkspace?: PreparedThreadWorkspace;
  readonly lastTurnId?: TurnId | null;
  readonly developerInstructions?: string;
}

export interface CodexThreadForkImportResult {
  readonly thread: ThreadOrchestrationThreadSummary;
  readonly sourceProviderThreadId: string;
  readonly providerThreadId: string;
  readonly importedMessageCount: number;
}

export class CodexThreadForkImporter extends Context.Service<
  CodexThreadForkImporter,
  {
    readonly fork: (
      input: CodexThreadForkImportInput,
    ) => Effect.Effect<CodexThreadForkImportResult, ThreadOrchestrationError>;
  }
>()("t3/mcp/toolkits/thread-orchestration/CodexThreadForkImporter") {}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const providerRegistry = yield* ProviderRegistry;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const fork = (input: CodexThreadForkImportInput) => {
    let createdThread = false;
    const cleanupCreatedThread = () =>
      createdThread
        ? engine
            .dispatch({
              type: "thread.delete",
              commandId: CommandId.make(`codex-fork-thread-rollback:${input.threadId}`),
              threadId: input.threadId,
            })
            .pipe(Effect.ignoreCause({ log: true }))
        : Effect.void;

    return Effect.gen(function* () {
      const bindingOption = yield* providerSessionDirectory
        .getBinding(input.sourceThread.id)
        .pipe(Effect.mapError(toThreadOrchestrationError(input, "fork_thread.codex_binding_read")));
      if (Option.isNone(bindingOption)) {
        return yield* unsupportedSource(input.sourceThread.id, "has no provider session");
      }
      const binding = bindingOption.value;
      if (binding.provider !== CODEX_DRIVER) {
        return yield* unsupportedSource(input.sourceThread.id, "is not backed by Codex");
      }

      const sourceProviderThreadId = providerThreadIdFromResumeCursor(binding.resumeCursor);
      if (!sourceProviderThreadId) {
        return yield* unsupportedSource(input.sourceThread.id, "has no Codex provider thread id");
      }

      const providers = yield* providerRegistry.getProviders;
      const codexProvider =
        (binding.providerInstanceId
          ? providers.find(
              (provider) =>
                provider.driver === CODEX_DRIVER &&
                provider.instanceId === binding.providerInstanceId &&
                provider.enabled &&
                provider.availability !== "unavailable",
            )
          : undefined) ??
        providers.find(
          (provider) =>
            provider.driver === CODEX_DRIVER &&
            provider.instanceId === DEFAULT_CODEX_INSTANCE_ID &&
            provider.enabled &&
            provider.availability !== "unavailable",
        ) ??
        providers.find(
          (provider) =>
            provider.driver === CODEX_DRIVER &&
            provider.enabled &&
            provider.availability !== "unavailable",
        );
      if (!codexProvider) {
        return yield* new ThreadOrchestrationError({
          operation: "fork_thread.codex",
          code: "operation_failed",
          message: "No enabled Codex provider instance is available.",
          threadId: input.sourceThread.id,
          projectId: input.project.id,
        });
      }

      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(toThreadOrchestrationError(input, "fork_thread.codex_settings")),
      );
      const instanceEnvelope = settings.providerInstances[codexProvider.instanceId];
      const usesLegacyDefault =
        codexProvider.instanceId === DEFAULT_CODEX_INSTANCE_ID && instanceEnvelope === undefined;
      const decodedConfig = yield* decodeCodexSettings(
        usesLegacyDefault ? settings.providers.codex : (instanceEnvelope?.config ?? {}),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ThreadOrchestrationError({
              operation: "fork_thread.codex_config",
              code: "operation_failed",
              message: "Failed to read Codex provider configuration.",
              threadId: input.sourceThread.id,
              projectId: input.project.id,
              cause,
            }),
        ),
      );
      const codexConfig = {
        ...decodedConfig,
        enabled: instanceEnvelope?.enabled ?? decodedConfig.enabled,
      };
      const providerEnvironment = usesLegacyDefault ? undefined : instanceEnvelope?.environment;
      const processEnv = mergeProviderInstanceEnvironment(providerEnvironment);
      const homeLayout = yield* resolveCodexHomeLayout(codexConfig).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(toThreadOrchestrationError(input, "fork_thread.codex_home")),
      );
      yield* materializeCodexShadowHome(homeLayout).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(toThreadOrchestrationError(input, "fork_thread.codex_home")),
      );

      const forkResponse = yield* forkCodexProviderThread({
        providerThreadId: sourceProviderThreadId,
        binaryPath: codexConfig.binaryPath,
        configCwd: config.cwd,
        spawner,
        ...(input.preparedWorkspace !== undefined
          ? { cwd: input.preparedWorkspace.primaryCwd }
          : {}),
        ...(homeLayout.effectiveHomePath ? { homePath: homeLayout.effectiveHomePath } : {}),
        environment: processEnv,
        ...(input.lastTurnId !== undefined ? { lastTurnId: input.lastTurnId } : {}),
        ...(input.developerInstructions
          ? { developerInstructions: input.developerInstructions }
          : {}),
      }).pipe(Effect.mapError(toThreadOrchestrationError(input, "fork_thread.codex_fork")));

      yield* engine
        .dispatch({
          type: "thread.create",
          commandId: CommandId.make(`codex-fork-thread-create:${input.threadId}`),
          threadId: input.threadId,
          projectId: input.project.id,
          title: input.title,
          modelSelection: input.sourceThread.modelSelection,
          runtimeMode: input.sourceThread.runtimeMode,
          interactionMode: input.sourceThread.interactionMode,
          ...(input.sourceThread.skillScope
            ? { skillPackIds: input.sourceThread.skillScope.packIds }
            : {}),
          branch: input.preparedWorkspace?.compatibilityBranch ?? input.sourceThread.branch,
          worktreePath:
            input.preparedWorkspace?.compatibilityWorktreePath ?? input.sourceThread.worktreePath,
          workspaceId: input.preparedWorkspace?.workspace.id ?? input.sourceThread.workspaceId,
          createdAt: input.createdAt,
        })
        .pipe(Effect.mapError(toThreadOrchestrationError(input, "fork_thread.codex_create")));
      createdThread = true;

      const messages = codexThreadMessages({
        thread: forkResponse.thread,
        importedAt: input.createdAt,
      });
      if (messages.length > 0) {
        yield* engine
          .dispatch({
            type: "thread.messages.import",
            commandId: CommandId.make(`codex-fork-messages-import:${input.threadId}`),
            threadId: input.threadId,
            messages,
            createdAt: input.createdAt,
          })
          .pipe(Effect.mapError(toThreadOrchestrationError(input, "fork_thread.codex_import")));
      }

      yield* providerSessionDirectory
        .upsert({
          threadId: input.threadId,
          provider: CODEX_DRIVER,
          providerInstanceId: codexProvider.instanceId,
          status: "stopped",
          resumeCursor: { threadId: forkResponse.thread.id },
          runtimePayload: {
            cwd: forkResponse.thread.cwd,
            modelSelection: input.sourceThread.modelSelection,
            source: "codex-thread-fork",
            sourceThreadId: input.sourceThread.id,
            sourceProviderThreadId,
          },
          runtimeMode: input.sourceThread.runtimeMode,
        })
        .pipe(Effect.mapError(toThreadOrchestrationError(input, "fork_thread.codex_binding")));

      yield* engine
        .dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`codex-fork-session-set:${input.threadId}`),
          threadId: input.threadId,
          session: {
            threadId: input.threadId,
            status: "stopped",
            providerName: CODEX_DRIVER,
            providerInstanceId: codexProvider.instanceId,
            runtimeMode: input.sourceThread.runtimeMode,
            activeTurnId: null,
            lastError: null,
            updatedAt: input.createdAt,
          },
          createdAt: input.createdAt,
        })
        .pipe(Effect.mapError(toThreadOrchestrationError(input, "fork_thread.codex_session")));

      return {
        thread: {
          environmentId: (yield* environment.getDescriptor).environmentId,
          threadId: input.threadId,
          projectId: input.project.id,
          title: input.title,
          projectTitle: input.project.title,
          status: "idle" as const,
          modelSelection: input.sourceThread.modelSelection,
          runtimeMode: input.sourceThread.runtimeMode,
          interactionMode: input.sourceThread.interactionMode,
          workspaceRoot: input.project.workspaceRoot,
          worktreePath:
            input.preparedWorkspace?.compatibilityWorktreePath ?? input.sourceThread.worktreePath,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        },
        sourceProviderThreadId,
        providerThreadId: forkResponse.thread.id,
        importedMessageCount: messages.length,
      };
    }).pipe(
      Effect.catch((cause: ThreadOrchestrationError) =>
        cleanupCreatedThread().pipe(Effect.flatMap(() => Effect.fail(cause))),
      ),
    );
  };

  return { fork };
});

export const CodexThreadForkImporterLive = Layer.effect(CodexThreadForkImporter, make);

function unsupportedSource(threadId: ThreadId, reason: string) {
  return new ThreadOrchestrationError({
    operation: "fork_thread.codex",
    code: "unsupported_source",
    message: `Thread '${threadId}' cannot be forked through Codex App Server because it ${reason}.`,
    threadId,
  });
}

function providerThreadIdFromResumeCursor(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || !("threadId" in resumeCursor)) {
    return undefined;
  }
  const raw = resumeCursor.threadId;
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toThreadOrchestrationError(input: CodexThreadForkImportInput, operation: string) {
  return (cause: unknown) =>
    new ThreadOrchestrationError({
      operation,
      code: "operation_failed",
      message: `Thread orchestration operation '${operation}' failed.`,
      threadId: input.threadId,
      projectId: input.project.id,
      cause,
    });
}
