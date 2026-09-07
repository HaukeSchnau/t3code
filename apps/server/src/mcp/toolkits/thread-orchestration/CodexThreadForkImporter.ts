import {
  CodexSettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ThreadId,
  ThreadOrchestrationError,
  type OrchestrationProjectShell,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type ProviderThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../../../config.ts";
import { CodexProviderCapabilitiesV2 } from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { EventSinkV2 } from "../../../orchestration-v2/EventSink.ts";
import { IdAllocatorV2 } from "../../../orchestration-v2/IdAllocator.ts";
import {
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "../../../provider/Drivers/CodexHomeLayout.ts";
import {
  codexThreadMessages,
  forkCodexProviderThread,
  type CodexProviderThread,
} from "../../../provider/CodexThreadBridge.ts";
import { mergeProviderInstanceEnvironment } from "../../../provider/ProviderInstanceEnvironment.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import type { PreparedThreadWorkspace } from "../../../workspace/ThreadWorkspaceService.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const DEFAULT_CODEX_INSTANCE_ID = defaultInstanceIdForDriver(CODEX_DRIVER);
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const isThreadOrchestrationError = Schema.is(ThreadOrchestrationError);

/**
 * Forks an arbitrary native Codex transcript into a V2 thread. This remains
 * separate from `thread.fork`, which intentionally accepts only a completed
 * V2 run and cannot represent native deep-links or truncated transcripts.
 */
export interface CodexThreadForkImportInput {
  readonly threadId: ThreadId;
  readonly sourceThread: OrchestrationV2AppThread;
  readonly sourceProviderThread: OrchestrationV2ProviderThread;
  readonly project: OrchestrationProjectShell;
  readonly title: string;
  readonly createdAt: DateTime.Utc;
  readonly createdBy?: OrchestrationV2AppThread["createdBy"];
  readonly creationSource?: OrchestrationV2AppThread["creationSource"];
  readonly preparedWorkspace?: PreparedThreadWorkspace;
  readonly lastTurnId?: string | null;
  readonly developerInstructions?: string;
  /** Reuse an already-read native transcript for Codex resume imports. */
  readonly nativeThread?: CodexProviderThread;
}

export interface CodexThreadForkImportResult {
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly sourceProviderThreadId: ProviderThreadId;
  readonly importedMessageCount: number;
  readonly projection: OrchestrationV2ThreadProjection;
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
  const providerRegistry = yield* ProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const eventSink = yield* EventSinkV2;
  const idAllocator = yield* IdAllocatorV2;

  const fork = (input: CodexThreadForkImportInput) =>
    Effect.gen(function* () {
      if (
        input.sourceProviderThread.driver !== CODEX_DRIVER ||
        input.sourceProviderThread.nativeThreadRef?.driver !== CODEX_DRIVER ||
        input.sourceProviderThread.nativeThreadRef.strength !== "strong" ||
        input.sourceProviderThread.nativeThreadRef.nativeId === null
      ) {
        return yield* unsupportedSource(
          input.sourceThread.id,
          "has no strong Codex native thread ref",
        );
      }
      const sourceNativeId = input.sourceProviderThread.nativeThreadRef.nativeId;
      const sourceProviderThreadId = input.sourceProviderThread.id;
      const providers = yield* providerRegistry.getProviders;
      const providerCandidates: ReadonlyArray<{
        readonly driver: ProviderDriverKind;
        readonly instanceId: ProviderInstanceId;
        readonly enabled: boolean;
        readonly availability?: string;
      }> = providers.map((provider) => ({
        driver: provider.driver,
        instanceId: provider.instanceId,
        enabled: provider.enabled,
        availability: provider.availability ?? "available",
      }));
      const codexProvider = selectCodexProvider(
        providerCandidates,
        input.sourceProviderThread.providerInstanceId,
        input.sourceThread.providerInstanceId,
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

      const forkResponse =
        input.nativeThread === undefined
          ? yield* forkCodexProviderThread({
              providerThreadId: sourceNativeId,
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
            }).pipe(Effect.mapError(toThreadOrchestrationError(input, "fork_thread.codex_fork")))
          : { thread: input.nativeThread };

      const targetProviderThreadId = idAllocator.derive.providerThread({
        driver: CODEX_DRIVER,
        nativeThreadId: forkResponse.thread.id,
      });
      const providerSessionId = yield* idAllocator.allocate.providerSession({
        providerInstanceId: codexProvider.instanceId,
        threadId: input.threadId,
      });
      const targetCwd =
        input.preparedWorkspace?.primaryCwd ?? forkResponse.thread.cwd ?? config.cwd;
      const thread: OrchestrationV2AppThread = {
        ...input.sourceThread,
        createdBy: input.createdBy ?? "user",
        creationSource: input.creationSource ?? "mcp",
        id: input.threadId,
        projectId: input.project.id,
        title: input.title,
        providerInstanceId: codexProvider.instanceId,
        workspaceId:
          input.preparedWorkspace?.workspace.id ?? input.sourceThread.workspaceId ?? null,
        worktreePath:
          input.preparedWorkspace?.compatibilityWorktreePath ?? input.sourceThread.worktreePath,
        branch: input.preparedWorkspace?.compatibilityBranch ?? input.sourceThread.branch,
        activeProviderThreadId: targetProviderThreadId,
        historyOrigin: "native",
        lineage: {
          parentThreadId: input.sourceThread.id,
          relationshipToParent: "fork",
          rootThreadId: input.sourceThread.lineage.rootThreadId,
        },
        forkedFrom: { type: "provider_thread", providerThreadId: sourceProviderThreadId },
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      const providerSession: OrchestrationV2ProviderSession = {
        id: providerSessionId,
        driver: CODEX_DRIVER,
        providerInstanceId: codexProvider.instanceId,
        status: "stopped",
        cwd: targetCwd,
        model: input.sourceThread.modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        lastError: null,
      };
      const providerThread: OrchestrationV2ProviderThread = {
        id: targetProviderThreadId,
        driver: CODEX_DRIVER,
        providerInstanceId: codexProvider.instanceId,
        providerSessionId,
        appThreadId: input.threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver: CODEX_DRIVER,
          nativeId: forkResponse.thread.id,
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: { providerThreadId: sourceProviderThreadId },
        pendingBackgroundTasks: [],
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      };

      const messages = codexThreadMessages({
        thread: forkResponse.thread,
        importedAt: DateTime.formatIso(input.createdAt),
        ...(input.lastTurnId === null ? { importThroughTurnId: null } : {}),
      });
      const commandId = yield* idAllocator.allocate.command({
        fixtureName: "codex-thread-fork",
        commandName: input.threadId,
      });
      const events: Array<OrchestrationV2DomainEvent> = [];
      const append = (event: Omit<OrchestrationV2DomainEvent, "id">) =>
        Effect.gen(function* () {
          events.push({
            ...event,
            id: yield* idAllocator.allocate.event({
              threadId: input.threadId,
              commandId,
              providerSessionId,
            }),
          } as OrchestrationV2DomainEvent);
        });

      yield* append({
        type: "thread.created",
        threadId: input.threadId,
        providerInstanceId: codexProvider.instanceId,
        occurredAt: input.createdAt,
        payload: thread,
      });
      yield* append({
        type: "provider-session.attached",
        threadId: input.threadId,
        driver: CODEX_DRIVER,
        providerInstanceId: codexProvider.instanceId,
        occurredAt: input.createdAt,
        payload: providerSession,
      });
      yield* append({
        type: "provider-thread.updated",
        threadId: input.threadId,
        driver: CODEX_DRIVER,
        providerInstanceId: codexProvider.instanceId,
        occurredAt: input.createdAt,
        payload: providerThread,
      });
      for (const [ordinal, message] of messages.entries()) {
        const messageId = message.id;
        const timestamp = DateTime.makeUnsafe(message.createdAt);
        const conversationMessage: OrchestrationV2ConversationMessage = {
          createdBy: message.role === "user" ? "user" : "agent",
          creationSource: "provider",
          id: messageId,
          threadId: input.threadId,
          runId: null,
          nodeId: null,
          role: message.role,
          text: message.text,
          attachments: [],
          streaming: false,
          createdAt: timestamp,
          updatedAt: DateTime.makeUnsafe(message.updatedAt),
        };
        const turnItemId = idAllocator.derive.turnItemFromProviderItem({
          driver: CODEX_DRIVER,
          nativeItemId: messageId,
        });
        const turnItem: OrchestrationV2TurnItem =
          message.role === "user"
            ? {
                createdBy: "user",
                creationSource: "provider",
                id: turnItemId,
                threadId: input.threadId,
                runId: null,
                nodeId: null,
                providerThreadId: targetProviderThreadId,
                providerTurnId: null,
                nativeItemRef: { driver: CODEX_DRIVER, nativeId: messageId, strength: "weak" },
                parentItemId: null,
                ordinal,
                status: "completed",
                title: null,
                startedAt: timestamp,
                completedAt: timestamp,
                updatedAt: timestamp,
                type: "user_message",
                messageId,
                inputIntent: "turn_start",
                text: message.text,
                attachments: [],
              }
            : {
                id: turnItemId,
                threadId: input.threadId,
                runId: null,
                nodeId: null,
                providerThreadId: targetProviderThreadId,
                providerTurnId:
                  message.turnId === null
                    ? null
                    : idAllocator.derive.providerTurn({
                        driver: CODEX_DRIVER,
                        nativeTurnId: message.turnId,
                      }),
                nativeItemRef: { driver: CODEX_DRIVER, nativeId: messageId, strength: "weak" },
                parentItemId: null,
                ordinal,
                status: "completed",
                title: null,
                startedAt: timestamp,
                completedAt: timestamp,
                updatedAt: timestamp,
                type: "assistant_message",
                messageId,
                text: message.text,
                attachments: [],
                streaming: false,
              };
        yield* append({
          type: "message.updated",
          threadId: input.threadId,
          driver: CODEX_DRIVER,
          providerInstanceId: codexProvider.instanceId,
          occurredAt: timestamp,
          payload: conversationMessage,
        });
        yield* append({
          type: "turn-item.updated",
          threadId: input.threadId,
          driver: CODEX_DRIVER,
          providerInstanceId: codexProvider.instanceId,
          occurredAt: timestamp,
          payload: turnItem,
        });
      }
      yield* eventSink.write({ commandId, events });
      const projection: OrchestrationV2ThreadProjection = {
        thread,
        runs: [],
        attempts: [],
        nodes: [],
        subagents: [],
        providerSessions: [providerSession],
        providerThreads: [providerThread],
        providerTurns: [],
        runtimeRequests: [],
        messages: events.flatMap((event) =>
          event.type === "message.updated" ? [event.payload] : [],
        ),
        plans: [],
        turnItems: events.flatMap((event) =>
          event.type === "turn-item.updated" ? [event.payload] : [],
        ),
        checkpointScopes: [],
        checkpoints: [],
        contextHandoffs: [],
        contextTransfers: [],
        visibleTurnItems: [],
        updatedAt: input.createdAt,
      };
      return {
        threadId: input.threadId,
        providerThreadId: targetProviderThreadId,
        sourceProviderThreadId,
        importedMessageCount: messages.length,
        projection,
      };
    }).pipe(
      Effect.mapError((cause) => {
        if (isThreadOrchestrationError(cause)) return cause;
        return toThreadOrchestrationError(input, "fork_thread.codex")(cause);
      }),
    );

  return { fork };
});

export const CodexThreadForkImporterLive = Layer.effect(CodexThreadForkImporter, make);

function selectCodexProvider(
  providers: ReadonlyArray<{
    readonly driver: ProviderDriverKind;
    readonly instanceId: ProviderInstanceId;
    readonly enabled: boolean;
    readonly availability?: string;
  }>,
  ...preferredInstanceIds: ReadonlyArray<ProviderInstanceId>
) {
  const usable = providers.filter(
    (provider) =>
      provider.driver === CODEX_DRIVER &&
      provider.enabled &&
      provider.availability !== "unavailable",
  );
  return (
    preferredInstanceIds
      .map((instanceId) => usable.find((provider) => provider.instanceId === instanceId))
      .find(Boolean) ??
    usable.find((provider) => provider.instanceId === DEFAULT_CODEX_INSTANCE_ID) ??
    usable[0]
  );
}

function unsupportedSource(threadId: ThreadId, reason: string) {
  return new ThreadOrchestrationError({
    operation: "fork_thread.codex",
    code: "unsupported_source",
    message: `Thread '${threadId}' cannot be forked through Codex App Server because it ${reason}.`,
    threadId,
  });
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
