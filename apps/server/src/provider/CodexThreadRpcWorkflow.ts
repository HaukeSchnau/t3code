import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  CodexSettings,
  CodexThreadForkError,
  CodexThreadResumeError,
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderThreadId,
  ThreadId,
  defaultInstanceIdForDriver,
  type CodexThreadForkInput,
  type CodexThreadResumeInput,
  type OrchestrationProjectShell,
  type OrchestrationThreadActivity,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  type ThreadWorkspaceKind,
  type ThreadWorkspaceRetentionPolicy,
  type ThreadWorkspaceRootRole,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { CodexThreadForkImporter } from "../mcp/toolkits/thread-orchestration/CodexThreadForkImporter.ts";
import type { ThreadManagementServiceShape } from "../orchestration-v2/ThreadManagementService.ts";
import { materializeCodexShadowHome, resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";
import { codexThreadTitle, pathBasename, readCodexProviderThread } from "./CodexThreadBridge.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import type * as ProviderRegistry from "./Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadWorkspaceService from "../workspace/ThreadWorkspaceService.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const DEFAULT_CODEX_INSTANCE_ID = defaultInstanceIdForDriver(CODEX_DRIVER);
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const isCodexThreadResumeError = Schema.is(CodexThreadResumeError);
const isCodexThreadForkError = Schema.is(CodexThreadForkError);

type ThreadWorkspacePrepareRequest = {
  readonly kind?: "auto" | Exclude<ThreadWorkspaceKind, "local"> | undefined;
  readonly roots: ReadonlyArray<{
    readonly projectId: ProjectId;
    readonly sourcePath: string;
    readonly role: ThreadWorkspaceRootRole;
    readonly baseRevision?: string | null | undefined;
    readonly startFromOrigin?: boolean | undefined;
  }>;
  readonly displayNameSeed?: string | undefined;
  readonly retentionPolicy?: ThreadWorkspaceRetentionPolicy | undefined;
};

function codexForkSourceBusyReason(projection: OrchestrationV2ThreadProjection): string | null {
  if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) {
    return "Cannot fork an archived thread.";
  }
  if (
    projection.runs.some((run) =>
      ["preparing", "starting", "running", "waiting"].includes(run.status),
    )
  ) {
    return "Cannot fork a thread while its latest turn is still running.";
  }
  if (projection.messages.some((message) => message.streaming)) {
    return "Cannot fork a thread while a message is still streaming.";
  }
  if (projection.runs.some((run) => run.status === "queued")) {
    return "Cannot fork a thread while it has queued messages.";
  }
  if (projection.runtimeRequests.some((request) => request.status === "pending")) {
    return "Cannot fork a thread while it is waiting on approval or user input.";
  }
  return null;
}

function providerThreadForProjection(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ProviderThread | undefined {
  const activeId = projection.thread.activeProviderThreadId;
  return (
    projection.providerThreads.find((thread) => thread.id === activeId) ??
    projection.providerThreads.find(
      (thread) =>
        thread.nativeThreadRef?.driver === CODEX_DRIVER &&
        thread.nativeThreadRef.strength === "strong" &&
        thread.nativeThreadRef.nativeId !== null,
    )
  );
}

function nativeTurnIdForRun(
  projection: OrchestrationV2ThreadProjection,
  runId: string | null | undefined,
): string | null {
  if (runId === null || runId === undefined) return null;
  const run = projection.runs.find((candidate) => candidate.id === runId);
  const attempt = run?.activeAttemptId
    ? projection.attempts.find((candidate) => candidate.id === run.activeAttemptId)
    : projection.attempts.find((candidate) => candidate.runId === runId);
  const providerTurn = attempt?.providerTurnId
    ? projection.providerTurns.find((candidate) => candidate.id === attempt.providerTurnId)
    : undefined;
  return providerTurn?.nativeTurnRef?.nativeId ?? null;
}

function projectShellForThread(input: {
  readonly projectId: ProjectId;
  readonly cwd: string;
  readonly modelSelection: OrchestrationV2AppThread["modelSelection"];
  readonly title: string;
  readonly createdAt: DateTime.Utc;
}): OrchestrationProjectShell {
  const createdAt = DateTime.formatIso(input.createdAt);
  return {
    id: input.projectId,
    title: input.title,
    workspaceRoot: input.cwd,
    defaultModelSelection: input.modelSelection,
    scripts: [],
    createdAt,
    updatedAt: createdAt,
  };
}

function syntheticSourceThread(input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly modelSelection: OrchestrationV2AppThread["modelSelection"];
  readonly cwd: string;
  readonly title: string;
  readonly createdAt: DateTime.Utc;
}): OrchestrationV2AppThread {
  return {
    id: input.threadId,
    projectId: input.projectId,
    title: input.title,
    providerInstanceId: input.modelSelection.instanceId,
    modelSelection: input.modelSelection,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: input.cwd,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "mcp",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function syntheticProviderThread(input: {
  readonly providerThreadId: ProviderThreadId;
  readonly providerInstanceId: OrchestrationV2AppThread["providerInstanceId"];
  readonly createdAt: DateTime.Utc;
}): OrchestrationV2ProviderThread {
  return {
    id: input.providerThreadId,
    driver: CODEX_DRIVER,
    providerInstanceId: input.providerInstanceId,
    providerSessionId: null,
    appThreadId: null,
    ownerNodeId: null,
    nativeThreadRef: {
      driver: CODEX_DRIVER,
      nativeId: input.providerThreadId,
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

/** Compatibility RPC for native Codex deep links backed entirely by V2 services. */
export const makeCodexThreadRpcWorkflow = (input: {
  readonly configCwd: string;
  readonly threadManagement: ThreadManagementServiceShape;
  readonly providerRegistry: ProviderRegistry.ProviderRegistryShape;
  readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
  readonly threadWorkspaceService: ThreadWorkspaceService.ThreadWorkspaceService["Service"];
  readonly codexThreadForkImporter: CodexThreadForkImporter["Service"];
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const commandId = (tag: string) =>
      crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
    const eventId = (tag: string) =>
      crypto.randomUUIDv4.pipe(Effect.map((uuid) => EventId.make(`server:${tag}:${uuid}`)));

    const prepareWorkspace = (request: {
      readonly threadId: ThreadId;
      readonly request: ThreadWorkspacePrepareRequest;
    }) =>
      input.threadWorkspaceService.prepareWorkspace({
        threadId: request.threadId,
        kind: request.request.kind ?? "auto",
        roots: request.request.roots.map((root) => ({
          projectId: root.projectId,
          sourcePath: root.sourcePath,
          role: root.role,
          ...(root.baseRevision !== undefined ? { baseRevision: root.baseRevision } : {}),
          ...(root.startFromOrigin !== undefined ? { startFromOrigin: root.startFromOrigin } : {}),
        })),
        ...(request.request.displayNameSeed === undefined
          ? {}
          : { displayNameSeed: request.request.displayNameSeed }),
        retentionPolicy: request.request.retentionPolicy ?? "explicit-delete",
      });

    const appendActivity = (activity: {
      readonly threadId: ThreadId;
      readonly kind: string;
      readonly summary: string;
      readonly createdAt: DateTime.Utc;
      readonly payload: Record<string, unknown>;
    }) =>
      Effect.all({
        commandId: commandId("thread-activity"),
        activityId: eventId("thread-activity"),
      }).pipe(
        Effect.flatMap(({ commandId: activityCommandId, activityId }) =>
          input.threadManagement.dispatch({
            type: "coordination.activity.append",
            commandId: activityCommandId,
            threadId: activity.threadId,
            activity: {
              id: activityId,
              tone: "tool",
              kind: activity.kind,
              summary: activity.summary,
              payload: activity.payload,
              turnId: null,
              createdAt: DateTime.formatIso(activity.createdAt),
            } satisfies OrchestrationThreadActivity,
          }),
        ),
        Effect.asVoid,
      );

    const findCodexProvider = Effect.gen(function* () {
      const providers = yield* input.providerRegistry.getProviders;
      return (
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
        )
      );
    });

    const readNativeThread = (providerThreadId: string) =>
      Effect.gen(function* () {
        const provider = yield* findCodexProvider;
        if (provider === undefined) {
          return yield* new CodexThreadResumeError({
            message: "No enabled Codex provider instance is available.",
          });
        }
        const settings = yield* input.serverSettings.getSettings;
        const envelope = settings.providerInstances[provider.instanceId];
        const usesLegacyDefault =
          provider.instanceId === DEFAULT_CODEX_INSTANCE_ID && envelope === undefined;
        const decoded = yield* decodeCodexSettings(
          usesLegacyDefault ? settings.providers.codex : (envelope?.config ?? {}),
        );
        const codexConfig = { ...decoded, enabled: envelope?.enabled ?? decoded.enabled };
        const environment = mergeProviderInstanceEnvironment(
          usesLegacyDefault ? undefined : envelope?.environment,
        );
        const homeLayout = yield* resolveCodexHomeLayout(codexConfig);
        yield* materializeCodexShadowHome(homeLayout);
        const response = yield* readCodexProviderThread({
          providerThreadId,
          binaryPath: codexConfig.binaryPath,
          configCwd: input.configCwd,
          spawner: input.childProcessSpawner,
          ...(homeLayout.effectiveHomePath ? { homePath: homeLayout.effectiveHomePath } : {}),
          environment,
        });
        return {
          provider,
          native: response.thread,
          model: provider.models[0]?.slug ?? DEFAULT_MODEL,
        };
      });

    const resume = (request: CodexThreadResumeInput) =>
      Effect.gen(function* () {
        if (request.threadId.trim().length === 0) {
          return yield* new CodexThreadResumeError({ message: "Codex thread id is required." });
        }
        const nativeResult = yield* readNativeThread(request.threadId);
        const importedAt = yield* DateTime.now;
        const targetThreadId = ThreadId.make(nativeResult.native.id);
        const existing = yield* input.threadManagement
          .getThreadProjection(targetThreadId)
          .pipe(Effect.option);
        if (Option.isSome(existing)) {
          return {
            threadId: targetThreadId,
            projectId: existing.value.thread.projectId,
            providerThreadId: request.threadId,
            importedMessageCount: 0,
          };
        }
        const cwd = nativeResult.native.cwd ?? input.configCwd;
        const modelSelection = {
          instanceId: nativeResult.provider.instanceId,
          model: nativeResult.model,
        };
        const projectId = ProjectId.make(`codex-project:${cwd}`);
        const title = codexThreadTitle({
          ...(nativeResult.native.name === undefined ? {} : { name: nativeResult.native.name }),
          preview: nativeResult.native.preview ?? "",
          cwd,
        });
        const sourceThread = syntheticSourceThread({
          threadId: ThreadId.make(`codex-source:${nativeResult.native.id}`),
          projectId,
          modelSelection,
          cwd,
          title,
          createdAt: importedAt,
        });
        const sourceProviderThread = syntheticProviderThread({
          providerThreadId: ProviderThreadId.make(`codex-source:${nativeResult.native.id}`),
          providerInstanceId: nativeResult.provider.instanceId,
          createdAt: importedAt,
        });
        const imported = yield* input.codexThreadForkImporter.fork({
          threadId: targetThreadId,
          sourceThread,
          sourceProviderThread,
          project: projectShellForThread({
            projectId,
            cwd,
            modelSelection,
            title: pathBasename(cwd),
            createdAt: importedAt,
          }),
          title,
          createdAt: importedAt,
          nativeThread: nativeResult.native,
        });
        return {
          threadId: imported.threadId,
          projectId,
          providerThreadId: request.threadId,
          importedMessageCount: imported.importedMessageCount,
        };
      }).pipe(
        Effect.mapError((cause) =>
          isCodexThreadResumeError(cause)
            ? cause
            : new CodexThreadResumeError({
                message: cause instanceof Error ? cause.message : "Failed to resume Codex thread.",
                cause,
              }),
        ),
      );

    const fork = (request: CodexThreadForkInput) =>
      Effect.gen(function* () {
        const projection = yield* input.threadManagement.getThreadProjection(request.threadId);
        const sourceThread = projection.thread;
        const sourceProviderThread = providerThreadForProjection(projection);
        if (sourceProviderThread === undefined) {
          return yield* new CodexThreadForkError({
            message: `Thread '${request.threadId}' has no strong Codex provider thread.`,
          });
        }
        const nativeSourceId = sourceProviderThread.nativeThreadRef?.nativeId;
        if (nativeSourceId === null || nativeSourceId === undefined) {
          return yield* new CodexThreadForkError({
            message: `Thread '${request.threadId}' has no Codex native thread id.`,
          });
        }
        const busyReason = codexForkSourceBusyReason(projection);
        if (busyReason !== null) return yield* new CodexThreadForkError({ message: busyReason });

        let nativeLastTurnId =
          request.lastTurnId === undefined || request.lastTurnId === null
            ? null
            : (nativeTurnIdForRun(projection, request.lastTurnId) ?? String(request.lastTurnId));
        if (request.sourceMessageId !== undefined && request.sourceMessageId !== null) {
          const message = projection.messages.find(
            (candidate) => candidate.id === request.sourceMessageId,
          );
          if (message === undefined) {
            return yield* new CodexThreadForkError({
              message: `Message '${request.sourceMessageId}' was not found in thread '${request.threadId}'.`,
            });
          }
          if (message.role !== "assistant") {
            return yield* new CodexThreadForkError({
              message: "Only assistant messages can be used as Codex fork points.",
            });
          }
          if (message.streaming) {
            return yield* new CodexThreadForkError({
              message: "Cannot fork from an assistant message that is still streaming.",
            });
          }
          const nativeMessageTurn = nativeTurnIdForRun(projection, message.runId);
          if (nativeMessageTurn === null) {
            return yield* new CodexThreadForkError({
              message: `Message '${request.sourceMessageId}' is not attached to a completed Codex turn.`,
            });
          }
          nativeLastTurnId = nativeMessageTurn;
        }

        const createdAt = yield* DateTime.now;
        const targetThreadId = ThreadId.make(`codex-fork:${yield* crypto.randomUUIDv4}`);
        const sourceCwd = sourceThread.worktreePath ?? input.configCwd;
        const preparedWorkspace =
          request.workspace?.mode === "new"
            ? yield* prepareWorkspace({
                threadId: targetThreadId,
                request: {
                  ...(request.workspace.kind === undefined ? {} : { kind: request.workspace.kind }),
                  roots: [
                    { projectId: sourceThread.projectId, sourcePath: sourceCwd, role: "primary" },
                  ],
                  displayNameSeed: sourceThread.title,
                },
              }).pipe(
                Effect.mapError(
                  (cause) => new CodexThreadForkError({ message: cause.message, cause }),
                ),
              )
            : undefined;
        const targetCwd = preparedWorkspace?.primaryCwd ?? sourceCwd;
        const imported = yield* input.codexThreadForkImporter
          .fork({
            threadId: targetThreadId,
            sourceThread,
            sourceProviderThread,
            project: projectShellForThread({
              projectId: sourceThread.projectId,
              cwd: sourceCwd,
              modelSelection: sourceThread.modelSelection,
              title: sourceThread.title,
              createdAt,
            }),
            title: `Fork of ${sourceThread.title}`,
            createdAt,
            ...(preparedWorkspace ? { preparedWorkspace } : {}),
            ...(nativeLastTurnId === null ? {} : { lastTurnId: nativeLastTurnId }),
          })
          .pipe(
            Effect.catch((cause: unknown) =>
              Effect.gen(function* () {
                if (preparedWorkspace) {
                  yield* input.threadWorkspaceService
                    .deleteWorkspace({ workspaceId: preparedWorkspace.workspace.id, force: true })
                    .pipe(Effect.ignoreCause({ log: true }));
                }
                return yield* new CodexThreadForkError({
                  message: cause instanceof Error ? cause.message : "Failed to fork Codex thread.",
                  cause,
                });
              }),
            ),
          );
        const relationshipPayload = {
          provider: CODEX_DRIVER,
          sourceThreadId: request.threadId,
          destinationThreadId: imported.threadId,
          sourceProviderThreadId: sourceProviderThread.id,
          destinationProviderThreadId: imported.providerThreadId,
          sourceCwd,
          destinationCwd: targetCwd,
          workspace:
            preparedWorkspace === undefined
              ? { mode: "source" }
              : {
                  mode: "new",
                  workspaceId: preparedWorkspace.workspace.id,
                  kind: preparedWorkspace.workspace.kind,
                  primaryCwd: preparedWorkspace.primaryCwd,
                },
        };
        yield* Effect.all(
          [
            appendActivity({
              threadId: request.threadId,
              kind: "thread.forked-to",
              summary: `Forked to ${imported.threadId}`,
              createdAt,
              payload: relationshipPayload,
            }),
            appendActivity({
              threadId: imported.threadId,
              kind: "thread.forked-from",
              summary: `Forked from ${request.threadId}`,
              createdAt,
              payload: relationshipPayload,
            }),
          ],
          { concurrency: 1 },
        ).pipe(Effect.ignore);
        return {
          threadId: imported.threadId,
          projectId: sourceThread.projectId,
          sourceThreadId: request.threadId,
          providerThreadId: imported.providerThreadId,
          importedMessageCount: imported.importedMessageCount,
          workspaceId: preparedWorkspace?.workspace.id ?? null,
        };
      }).pipe(
        Effect.mapError((cause) =>
          isCodexThreadForkError(cause)
            ? cause
            : new CodexThreadForkError({
                message: cause instanceof Error ? cause.message : "Failed to fork Codex thread.",
                cause,
              }),
        ),
      );

    return { resume, fork };
  });
