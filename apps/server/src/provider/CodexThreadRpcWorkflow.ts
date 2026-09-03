import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  CodexSettings,
  CodexThreadForkError,
  CodexThreadResumeError,
  CommandId,
  EventId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  defaultInstanceIdForDriver,
  type CodexThreadForkInput,
  type CodexThreadResumeInput,
  type OrchestrationCommand,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
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

import type * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import type * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { CodexThreadForkImporter } from "../mcp/toolkits/thread-orchestration/CodexThreadForkImporter.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadWorkspaceService from "../workspace/ThreadWorkspaceService.ts";
import { materializeCodexShadowHome, resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";
import {
  codexThreadMessages,
  codexThreadTimestamp,
  codexThreadTitle,
  pathBasename,
  readCodexProviderThread,
} from "./CodexThreadBridge.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import type * as ProviderRegistry from "./Services/ProviderRegistry.ts";
import type * as ProviderSessionDirectory from "./Services/ProviderSessionDirectory.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const DEFAULT_CODEX_INSTANCE_ID = defaultInstanceIdForDriver(CODEX_DRIVER);
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const isCodexThreadResumeError = Schema.is(CodexThreadResumeError);
const isCodexThreadForkError = Schema.is(CodexThreadForkError);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

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

function threadActivityRequestId(activity: OrchestrationThreadActivity): string | null {
  if (typeof activity.payload !== "object" || activity.payload === null) return null;
  const requestId = (activity.payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" && requestId.trim().length > 0 ? requestId : null;
}

function pendingRequestFailureDetailIsStale(activity: OrchestrationThreadActivity): boolean {
  const payload =
    typeof activity.payload === "object" && activity.payload !== null
      ? (activity.payload as Record<string, unknown>)
      : null;
  const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : "";
  return (
    detail.includes("stale pending request") ||
    detail.includes("stale pending approval request") ||
    detail.includes("stale pending user-input request") ||
    detail.includes("unknown pending request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending user-input request") ||
    detail.includes("unknown pending user input request") ||
    detail.includes("unknown pending codex approval request") ||
    detail.includes("unknown pending codex user input request")
  );
}

function deriveThreadPendingRequestCount(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  kind: "approval" | "user-input",
): number {
  const openRequestIds = new Set<string>();
  for (const activity of [...activities].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  )) {
    const requestId = threadActivityRequestId(activity);
    if (requestId === null) continue;

    if (kind === "approval") {
      if (activity.kind === "approval.requested") {
        openRequestIds.add(requestId);
      } else if (activity.kind === "approval.resolved") {
        openRequestIds.delete(requestId);
      } else if (
        activity.kind === "provider.approval.respond.failed" &&
        pendingRequestFailureDetailIsStale(activity)
      ) {
        openRequestIds.delete(requestId);
      }
      continue;
    }

    if (activity.kind === "user-input.requested") {
      openRequestIds.add(requestId);
    } else if (activity.kind === "user-input.resolved") {
      openRequestIds.delete(requestId);
    } else if (
      activity.kind === "provider.user-input.respond.failed" &&
      pendingRequestFailureDetailIsStale(activity)
    ) {
      openRequestIds.delete(requestId);
    }
  }
  return openRequestIds.size;
}

function codexForkSourceBusyReason(thread: OrchestrationThread): string | null {
  if (thread.archivedAt !== null) return "Cannot fork an archived thread.";
  if (thread.latestTurn?.state === "running") {
    return "Cannot fork a thread while its latest turn is still running.";
  }
  if (thread.session?.activeTurnId !== null && thread.session?.activeTurnId !== undefined) {
    return "Cannot fork a thread while a provider turn is active.";
  }
  if (
    thread.session &&
    !["idle", "ready", "stopped", "interrupted", "error"].includes(thread.session.status)
  ) {
    return `Cannot fork a thread while its session is ${thread.session.status}.`;
  }
  if (thread.messages.some((message) => message.streaming)) {
    return "Cannot fork a thread while a message is still streaming.";
  }
  if ((thread.queuedMessages ?? []).length > 0) {
    return "Cannot fork a thread while it has queued messages.";
  }
  if (deriveThreadPendingRequestCount(thread.activities, "approval") > 0) {
    return "Cannot fork a thread while it is waiting on approval.";
  }
  if (deriveThreadPendingRequestCount(thread.activities, "user-input") > 0) {
    return "Cannot fork a thread while it is waiting on user input.";
  }
  return null;
}

function codexForkDeveloperInstructions(input: {
  readonly sourceCwd: string;
  readonly targetCwd: string;
  readonly workspaceMode: "same" | "new";
}): string {
  return [
    "This thread was forked by the user from an earlier T3 Code thread.",
    "The conversation history was imported, but execution continues from this destination thread.",
    `Source working directory: ${input.sourceCwd}`,
    `Current working directory: ${input.targetCwd}`,
    input.workspaceMode === "new"
      ? "T3 Code copied the source workspace into a new workspace before creating this fork."
      : "This fork uses the same workspace as the source thread.",
    "Use the current working directory as authoritative. Do not assume terminals, approvals, or host-local state from the source thread are still active.",
  ].join("\n");
}

export const makeCodexThreadRpcWorkflow = (input: {
  readonly configCwd: string;
  readonly orchestrationEngine: OrchestrationEngine.OrchestrationEngineShape;
  readonly projectionSnapshotQuery: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape;
  readonly providerRegistry: ProviderRegistry.ProviderRegistryShape;
  readonly providerSessionDirectory: ProviderSessionDirectory.ProviderSessionDirectoryShape;
  readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
  readonly threadWorkspaceService: ThreadWorkspaceService.ThreadWorkspaceService["Service"];
  readonly codexThreadForkImporter: CodexThreadForkImporter["Service"];
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly dispatchNormalizedCommand: (
    command: OrchestrationCommand,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
}) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const childProcessSpawner = input.childProcessSpawner;
    const randomUUID = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationDispatchCommandError({
            message: "Failed to generate orchestration command identifier.",
            cause,
          }),
      ),
    );
    const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
    const serverCommandId = (tag: string) =>
      randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

    const prepareThreadWorkspace = (request: {
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
        ...(request.request.displayNameSeed !== undefined
          ? { displayNameSeed: request.request.displayNameSeed }
          : {}),
        retentionPolicy: request.request.retentionPolicy ?? "explicit-delete",
      });

    const appendThreadActivity = (activity: {
      readonly threadId: ThreadId;
      readonly kind: string;
      readonly summary: string;
      readonly createdAt: string;
      readonly payload: Record<string, unknown>;
      readonly tone?: "info" | "tool" | "approval" | "error";
    }) =>
      Effect.all({
        commandId: serverCommandId("thread-activity"),
        activityId: serverEventId,
      }).pipe(
        Effect.flatMap(({ commandId, activityId }) =>
          input.orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId,
            threadId: activity.threadId,
            activity: {
              id: activityId,
              tone: activity.tone ?? "info",
              kind: activity.kind,
              summary: activity.summary,
              payload: activity.payload,
              turnId: null,
              createdAt: activity.createdAt,
            },
            createdAt: activity.createdAt,
          }),
        ),
      );

    const resume = (request: CodexThreadResumeInput) =>
      Effect.gen(function* () {
        const providerThreadId = request.threadId.trim();
        if (!providerThreadId) {
          return yield* new CodexThreadResumeError({ message: "Codex thread id is required." });
        }

        const providers = yield* input.providerRegistry.getProviders;
        const codexProvider =
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
          return yield* new CodexThreadResumeError({
            message: "No enabled Codex provider instance is available.",
          });
        }

        const settings = yield* input.serverSettings.getSettings;
        const instanceEnvelope = settings.providerInstances[codexProvider.instanceId];
        const usesLegacyDefault =
          codexProvider.instanceId === DEFAULT_CODEX_INSTANCE_ID && instanceEnvelope === undefined;
        const decodedConfig = yield* decodeCodexSettings(
          usesLegacyDefault ? settings.providers.codex : (instanceEnvelope?.config ?? {}),
        );
        const codexConfig = {
          ...decodedConfig,
          enabled: instanceEnvelope?.enabled ?? decodedConfig.enabled,
        };
        const providerEnvironment = usesLegacyDefault ? undefined : instanceEnvelope?.environment;
        const processEnv = mergeProviderInstanceEnvironment(providerEnvironment);
        const homeLayout = yield* resolveCodexHomeLayout(codexConfig);
        yield* materializeCodexShadowHome(homeLayout);

        const readResponse = yield* readCodexProviderThread({
          providerThreadId,
          binaryPath: codexConfig.binaryPath,
          configCwd: input.configCwd,
          spawner: childProcessSpawner,
          ...(homeLayout.effectiveHomePath ? { homePath: homeLayout.effectiveHomePath } : {}),
          environment: processEnv,
        });
        const providerThread = readResponse.thread;
        const threadId = ThreadId.make(providerThread.id);
        const importedAt = yield* nowIso;
        const modelSelection = {
          instanceId: codexProvider.instanceId,
          model: codexProvider.models[0]?.slug ?? DEFAULT_MODEL,
        };

        const readModel = yield* input.projectionSnapshotQuery.getCommandReadModel();
        const existingThread = readModel.threads.find(
          (thread) => thread.id === threadId && thread.deletedAt === null,
        );
        const projectId = existingThread
          ? existingThread.projectId
          : yield* input.projectionSnapshotQuery
              .getActiveProjectByWorkspaceRoot(providerThread.cwd)
              .pipe(
                Effect.flatMap(
                  Option.match({
                    onSome: (project) => Effect.succeed(project.id),
                    onNone: () =>
                      Effect.gen(function* () {
                        const nextProjectId = ProjectId.make(yield* randomUUID);
                        yield* input.dispatchNormalizedCommand({
                          type: "project.create",
                          commandId: yield* serverCommandId("codex-resume-project-create"),
                          projectId: nextProjectId,
                          title: pathBasename(providerThread.cwd),
                          workspaceRoot: providerThread.cwd,
                          defaultModelSelection: modelSelection,
                          createdAt: importedAt,
                        });
                        return nextProjectId;
                      }),
                  }),
                ),
              );

        if (!existingThread) {
          yield* input.dispatchNormalizedCommand({
            type: "thread.create",
            commandId: yield* serverCommandId("codex-resume-thread-create"),
            threadId,
            projectId,
            title: codexThreadTitle(providerThread),
            modelSelection,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt: codexThreadTimestamp(providerThread.createdAt, importedAt),
          });
        }

        const importedMessages = codexThreadMessages({
          thread: providerThread,
          importedAt,
          ...(existingThread
            ? { importThroughTurnId: existingThread.latestTurn?.turnId ?? null }
            : {}),
        });
        const existingMessageIds = new Set(existingThread?.messages.map((message) => message.id));
        const messagesToImport = importedMessages.filter(
          (message) => !existingMessageIds.has(message.id),
        );
        if (messagesToImport.length > 0) {
          yield* input.dispatchNormalizedCommand({
            type: "thread.messages.import",
            commandId: yield* serverCommandId("codex-resume-messages-import"),
            threadId,
            messages: messagesToImport,
            createdAt: importedAt,
          });
        }

        yield* input.providerSessionDirectory.upsert({
          threadId,
          provider: CODEX_DRIVER,
          providerInstanceId: codexProvider.instanceId,
          status: "stopped",
          resumeCursor: { threadId: providerThread.id },
          runtimePayload: {
            cwd: providerThread.cwd,
            modelSelection,
            source: "codex-thread-resume-deeplink",
          },
          runtimeMode: DEFAULT_RUNTIME_MODE,
        });
        yield* input.dispatchNormalizedCommand({
          type: "thread.session.set",
          commandId: yield* serverCommandId("codex-resume-session-set"),
          threadId,
          session: {
            threadId,
            status: "stopped",
            providerName: CODEX_DRIVER,
            providerInstanceId: codexProvider.instanceId,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            activeTurnId: null,
            lastError: null,
            updatedAt: importedAt,
          },
          createdAt: importedAt,
        });
        return {
          threadId,
          projectId,
          providerThreadId: providerThread.id,
          importedMessageCount: messagesToImport.length,
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
        const sourceThreadId = request.threadId;
        const requestedSourceMessageId = request.sourceMessageId ?? null;
        const requestedLastTurnId = request.lastTurnId ?? null;
        const bindingOption = yield* input.providerSessionDirectory.getBinding(sourceThreadId);
        if (Option.isNone(bindingOption)) {
          return yield* new CodexThreadForkError({
            message: `Thread '${sourceThreadId}' does not have a provider session to fork.`,
          });
        }
        const binding = bindingOption.value;
        if (binding.provider !== CODEX_DRIVER) {
          return yield* new CodexThreadForkError({
            message: `Thread '${sourceThreadId}' is not backed by a Codex provider session.`,
          });
        }
        const resumeCursor = binding.resumeCursor;
        const sourceProviderThreadId =
          resumeCursor &&
          typeof resumeCursor === "object" &&
          "threadId" in resumeCursor &&
          typeof resumeCursor.threadId === "string"
            ? resumeCursor.threadId.trim()
            : "";
        if (!sourceProviderThreadId) {
          return yield* new CodexThreadForkError({
            message: `Thread '${sourceThreadId}' is missing a Codex provider thread id.`,
          });
        }

        const sourceThreadOption =
          yield* input.projectionSnapshotQuery.getThreadDetailById(sourceThreadId);
        if (Option.isNone(sourceThreadOption)) {
          return yield* new CodexThreadForkError({
            message: `Thread '${sourceThreadId}' was not found.`,
          });
        }
        const sourceThread = sourceThreadOption.value;
        const busyReason = codexForkSourceBusyReason(sourceThread);
        if (busyReason) return yield* new CodexThreadForkError({ message: busyReason });
        let forkLastTurnId = requestedLastTurnId;

        if (requestedSourceMessageId) {
          const sourceMessage = sourceThread.messages.find(
            (message) => message.id === requestedSourceMessageId,
          );
          if (!sourceMessage) {
            return yield* new CodexThreadForkError({
              message: `Message '${requestedSourceMessageId}' was not found in thread '${sourceThreadId}'.`,
            });
          }
          if (sourceMessage.role !== "assistant") {
            return yield* new CodexThreadForkError({
              message: "Only assistant messages can be used as Codex fork points.",
            });
          }
          if (sourceMessage.streaming) {
            return yield* new CodexThreadForkError({
              message: "Cannot fork from an assistant message that is still streaming.",
            });
          }
          if (!sourceMessage.turnId) {
            return yield* new CodexThreadForkError({
              message: `Message '${requestedSourceMessageId}' is not attached to a completed Codex turn.`,
            });
          }
          if (requestedLastTurnId && requestedLastTurnId !== sourceMessage.turnId) {
            return yield* new CodexThreadForkError({
              message: `Message '${requestedSourceMessageId}' belongs to turn '${sourceMessage.turnId}', not '${requestedLastTurnId}'.`,
            });
          }
          forkLastTurnId = sourceMessage.turnId;
        }

        const readModel = yield* input.projectionSnapshotQuery.getCommandReadModel();
        const project = readModel.projects.find((entry) => entry.id === sourceThread.projectId);
        if (!project) {
          return yield* new CodexThreadForkError({
            message: `Project '${sourceThread.projectId}' for thread '${sourceThreadId}' was not found.`,
          });
        }

        const createdAt = yield* nowIso;
        const threadId = ThreadId.make(yield* randomUUID);
        const sourceCwd = sourceThread.worktreePath ?? project.workspaceRoot;
        const preparedWorkspace =
          request.workspace?.mode === "new"
            ? yield* prepareThreadWorkspace({
                threadId,
                request: {
                  ...(request.workspace.kind !== undefined ? { kind: request.workspace.kind } : {}),
                  roots: [{ projectId: project.id, sourcePath: sourceCwd, role: "primary" }],
                  displayNameSeed: sourceThread.title,
                },
              }).pipe(
                Effect.mapError(
                  (cause) => new CodexThreadForkError({ message: cause.message, cause }),
                ),
              )
            : undefined;
        const targetCwd = preparedWorkspace?.primaryCwd ?? sourceCwd;
        const result = yield* input.codexThreadForkImporter
          .fork({
            threadId,
            sourceThread,
            project,
            title: `Fork of ${sourceThread.title}`,
            createdAt,
            ...(preparedWorkspace ? { preparedWorkspace } : {}),
            lastTurnId: forkLastTurnId,
            developerInstructions: codexForkDeveloperInstructions({
              sourceCwd,
              targetCwd,
              workspaceMode: preparedWorkspace === undefined ? "same" : "new",
            }),
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
          sourceThreadId,
          destinationThreadId: result.thread.threadId,
          sourceProjectId: sourceThread.projectId,
          destinationProjectId: result.thread.projectId,
          sourceProviderThreadId,
          destinationProviderThreadId: result.providerThreadId,
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
            appendThreadActivity({
              threadId: sourceThreadId,
              kind: "thread.forked-to",
              summary:
                preparedWorkspace === undefined
                  ? `Forked to ${result.thread.title}`
                  : `Forked to ${result.thread.title} in a new workspace`,
              payload: relationshipPayload,
              createdAt,
            }),
            appendThreadActivity({
              threadId: result.thread.threadId,
              kind: "thread.forked-from",
              summary:
                preparedWorkspace === undefined
                  ? `Forked from ${sourceThread.title}`
                  : `Forked from ${sourceThread.title} into a new workspace`,
              payload: relationshipPayload,
              createdAt,
            }),
          ],
          { concurrency: 1 },
        ).pipe(
          Effect.catch((cause: unknown) =>
            Effect.logWarning("Codex fork created but relationship activity recording failed", {
              sourceThreadId,
              destinationThreadId: result.thread.threadId,
              cause,
            }),
          ),
        );

        return {
          threadId: result.thread.threadId,
          projectId: result.thread.projectId,
          sourceThreadId,
          providerThreadId: result.providerThreadId,
          importedMessageCount: result.importedMessageCount,
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
