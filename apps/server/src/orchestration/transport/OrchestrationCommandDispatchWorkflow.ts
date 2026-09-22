import {
  CommandId,
  EventId,
  OrchestrationDispatchCommandError,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  type ProjectId,
  type ThreadId,
  type ThreadWorkspaceKind,
  type ThreadWorkspaceRetentionPolicy,
  type ThreadWorkspaceRootRole,
  type WorkspaceProfile,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  cleanupFailedUploadedAttachments,
  normalizeDispatchCommand,
  prepareDispatchCommand,
} from "../Normalizer.ts";
import type * as OrchestrationEngine from "../Services/OrchestrationEngine.ts";
import type { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import {
  type CommandPreprocessingProgress,
  CommandPreprocessingCoordinator,
  preprocessingCommandId,
} from "../Services/CommandPreprocessingCoordinator.ts";
import type * as ProjectionSnapshotQuery from "../Services/ProjectionSnapshotQuery.ts";
import { canReplaceThreadTitle, DEFAULT_THREAD_TITLE } from "../threadTitles.ts";
import type * as WorktreeSetupTracker from "../../project/WorktreeSetupTracker.ts";
import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import type * as ServerSettings from "../../serverSettings.ts";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import {
  type BootstrapWorkspaceNaming,
  generateBootstrapWorkspaceNaming,
} from "../../workspace/BootstrapWorkspaceNaming.ts";
import * as ThreadWorkspaceService from "../../workspace/ThreadWorkspaceService.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
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
  readonly profile?: WorkspaceProfile | undefined;
};

function setupFailureDescription(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  return String(cause);
}

function setupScriptFailureDetail(
  error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError,
): string {
  switch (error._tag) {
    case "ProjectSetupScriptOperationError":
      return setupFailureDescription(error.cause);
    case "ProjectSetupScriptProjectNotFoundError":
      return "Project was not found for setup script execution.";
    case "ProjectSetupScriptReconciliationTimeoutError":
    case "ProjectSetupScriptIdentityMismatchError":
      return error.message;
  }
}

export function makeOrchestrationCommandDispatchWorkflow(input: {
  readonly orchestrationEngine: OrchestrationEngine.OrchestrationEngineShape;
  readonly commandPreprocessing: CommandPreprocessingCoordinator["Service"];
  readonly projectCloneTracker: ProjectCloneTracker.ProjectCloneTracker["Service"];
  readonly worktreeSetupTracker: WorktreeSetupTracker.WorktreeSetupTracker["Service"];
  readonly recordWorktreeSetup: (snapshot: WorktreeSetupSnapshot) => Effect.Effect<void>;
  readonly startup: ServerRuntimeStartup.ServerRuntimeStartup["Service"];
  readonly projectionSnapshotQuery: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape;
  readonly textGeneration: TextGeneration.TextGeneration["Service"];
  readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
  readonly threadWorkspaceService: ThreadWorkspaceService.ThreadWorkspaceService["Service"];
  readonly projectSetupScriptRunner: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"];
  readonly terminalManager: TerminalManager.TerminalManager["Service"];
  readonly vcsStatusBroadcaster: VcsStatusBroadcaster.VcsStatusBroadcaster["Service"];
  readonly threadDeletionReactor: ThreadDeletionReactor["Service"];
  readonly dispatchCommand?: OrchestrationEngine.OrchestrationEngineShape["dispatch"];
  readonly onCommandDispatched?: (
    command: OrchestrationCommand,
  ) => Effect.Effect<void, never, never>;
}) {
  const dispatchCommand = input.dispatchCommand ?? input.orchestrationEngine.dispatch;
  const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
    isOrchestrationDispatchCommandError(cause)
      ? cause
      : new OrchestrationDispatchCommandError({
          message: cause instanceof Error ? cause.message : fallbackMessage,
          cause,
        });

  const refreshGitStatus = (cwd: string) =>
    input.vcsStatusBroadcaster
      .refreshStatus(cwd)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

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
      ...(request.request.profile !== undefined ? { profile: request.request.profile } : {}),
    });

  const appendSetupScriptActivity = (activity: {
    readonly parentCommand: Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
    readonly phase: string;
    readonly threadId: ThreadId;
    readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
    readonly summary: string;
    readonly createdAt: string;
    readonly payload: Record<string, unknown>;
    readonly tone: "info" | "error";
  }) => {
    const commandId = preprocessingCommandId(
      activity.parentCommand,
      `setup-activity-${activity.phase}`,
    );
    return dispatchCommand({
      type: "thread.activity.append",
      commandId,
      threadId: activity.threadId,
      activity: {
        id: EventId.make(`activity:${commandId}`),
        tone: activity.tone,
        kind: activity.kind,
        summary: activity.summary,
        payload: activity.payload,
        turnId: null,
        createdAt: activity.createdAt,
      },
      createdAt: activity.createdAt,
    });
  };

  const dispatchBootstrapTurnStart = (
    command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
    initialProgress: CommandPreprocessingProgress,
  ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
    Effect.gen(function* () {
      const bootstrap = command.bootstrap;
      let progress = initialProgress;
      let targetProjectId = bootstrap?.createThread?.projectId;
      let targetProjectCwd =
        bootstrap?.prepareWorkspace?.roots.find((root) => root.role === "primary")?.sourcePath ??
        bootstrap?.prepareWorktree?.projectCwd;
      let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;
      const prepareWorkspace =
        bootstrap?.prepareWorkspace ??
        (bootstrap?.prepareWorktree && targetProjectId
          ? {
              kind: "git-detached" as const,
              roots: [
                {
                  projectId: targetProjectId,
                  sourcePath: bootstrap.prepareWorktree.projectCwd,
                  role: "primary" as const,
                  baseRevision: bootstrap.prepareWorktree.baseBranch,
                  ...(bootstrap.prepareWorktree.startFromOrigin ? { startFromOrigin: true } : {}),
                },
              ],
              retentionPolicy: "explicit-delete" as const,
            }
          : undefined);
      const tracker = input.worktreeSetupTracker;
      const tracked = prepareWorkspace !== undefined;
      const track = (effect: Effect.Effect<void>) => (tracked ? effect : Effect.void);
      let preparingSessionSet = false;
      const setPreparingSession = (status: "starting" | "error", detail: string | null = null) =>
        dispatchCommand({
          type: "thread.session.set",
          commandId: preprocessingCommandId(command, `bootstrap-session-${status}`),
          threadId: command.threadId,
          session: {
            threadId: command.threadId,
            status,
            providerName: null,
            providerInstanceId:
              bootstrap?.createThread?.modelSelection.instanceId ??
              command.modelSelection?.instanceId,
            runtimeMode: command.runtimeMode,
            activeTurnId: null,
            lastError: detail,
            updatedAt: command.createdAt,
          },
          createdAt: command.createdAt,
        });
      const finish = (phase: "done" | "failed" | "cancelled", error?: string) =>
        tracked
          ? tracker
              .finish(command.threadId, phase, error)
              .pipe(
                Effect.flatMap((snapshot) =>
                  snapshot ? input.recordWorktreeSetup(snapshot) : Effect.void,
                ),
              )
          : Effect.void;
      const provisionalTitle =
        bootstrap?.createThread?.title ?? command.titleSeed ?? DEFAULT_THREAD_TITLE;
      const generateWorkspaceNaming = prepareWorkspace
        ? generateBootstrapWorkspaceNaming({
            threadId: command.threadId,
            cwd:
              prepareWorkspace.roots.find((root) => root.role === "primary")?.sourcePath ??
              targetProjectCwd ??
              process.cwd(),
            message: command.message.text,
            provisionalTitle,
            attachments: command.message.attachments,
            textGeneration: input.textGeneration,
            serverSettings: input.serverSettings,
          }).pipe(Effect.map((naming) => naming as BootstrapWorkspaceNaming | undefined))
        : Effect.succeed<BootstrapWorkspaceNaming | undefined>(undefined);
      let workspaceNaming: BootstrapWorkspaceNaming | undefined;

      const recordSetupScriptLaunchFailure = (failure: {
        readonly error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError;
        readonly requestedAt: string;
        readonly worktreePath: string;
      }) => {
        const detail = setupScriptFailureDetail(failure.error);
        return appendSetupScriptActivity({
          parentCommand: command,
          phase: "failed",
          threadId: command.threadId,
          kind: "setup-script.failed",
          summary: "Setup script failed to start",
          createdAt: failure.requestedAt,
          payload: { detail, worktreePath: failure.worktreePath },
          tone: "error",
        }).pipe(
          Effect.ignoreCause({ log: false }),
          Effect.flatMap(() =>
            Effect.logWarning("bootstrap turn start failed to launch setup script", {
              threadId: command.threadId,
              worktreePath: failure.worktreePath,
              detail,
            }),
          ),
        );
      };

      const recordSetupScriptStarted = (started: {
        readonly requestedAt: string;
        readonly worktreePath: string;
        readonly scriptId: string;
        readonly scriptName: string;
        readonly terminalId: string;
      }) =>
        Effect.gen(function* () {
          const startedAt = yield* nowIso;
          const payload = {
            scriptId: started.scriptId,
            scriptName: started.scriptName,
            terminalId: started.terminalId,
            worktreePath: started.worktreePath,
          };
          yield* Effect.all([
            appendSetupScriptActivity({
              parentCommand: command,
              phase: "requested",
              threadId: command.threadId,
              kind: "setup-script.requested",
              summary: "Starting setup script",
              createdAt: started.requestedAt,
              payload,
              tone: "info",
            }),
            appendSetupScriptActivity({
              parentCommand: command,
              phase: "started",
              threadId: command.threadId,
              kind: "setup-script.started",
              summary: "Setup script started",
              createdAt: startedAt,
              payload,
              tone: "info",
            }),
          ]).pipe(
            Effect.asVoid,
            Effect.catch((error) =>
              Effect.logWarning(
                "bootstrap turn start launched setup script but failed to record setup activity",
                {
                  threadId: command.threadId,
                  worktreePath: started.worktreePath,
                  scriptId: started.scriptId,
                  terminalId: started.terminalId,
                  detail: error.message,
                },
              ),
            ),
          );
        });

      const runSetupProgram = () =>
        Effect.gen(function* () {
          if (!bootstrap?.runSetupScript || !targetWorktreePath) {
            yield* track(tracker.stageStatus(command.threadId, "setup-script", "skipped"));
            return;
          }
          if (progress.setup.status === "completed") {
            yield* track(tracker.stageStatus(command.threadId, "setup-script", "done"));
            return;
          }

          const worktreePath = targetWorktreePath;
          const runnerInput = {
            threadId: command.threadId,
            ...(targetProjectId ? { projectId: targetProjectId } : {}),
            ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
            worktreePath,
            preferredTerminalId: `setup-${preprocessingCommandId(command, "setup-run")}`,
          };
          const reconcileClaimedLaunch = progress.setup.status === "claimed";
          if (progress.setup.status === "pending") {
            const resolution = yield* input.projectSetupScriptRunner.resolveForThread(runnerInput);
            if (resolution.status === "no-script") {
              yield* track(tracker.stageStatus(command.threadId, "setup-script", "skipped"));
              progress = yield* input.commandPreprocessing.markCompleted(
                command,
                "setup-completed",
              );
              return;
            }
            progress = yield* input.commandPreprocessing.claimSetup(command, resolution.execution);
          }
          if (progress.setup.status !== "claimed") return;

          yield* track(tracker.stageStatus(command.threadId, "setup-script", "running"));
          const requestedAt = yield* nowIso;
          yield* input.projectSetupScriptRunner
            .runForThread({
              ...runnerInput,
              reconcileClaimedLaunch,
              expectedExecution: progress.setup.execution,
              observeCompletion: {
                onOutputLine: (line) =>
                  track(tracker.appendTail(command.threadId, "setup-script", line)),
              },
            })
            .pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  recordSetupScriptLaunchFailure({ error, requestedAt, worktreePath }).pipe(
                    Effect.andThen(Effect.fail(error)),
                  ),
                onSuccess: (setupResult) =>
                  setupResult.status !== "started"
                    ? Effect.void
                    : recordSetupScriptStarted({
                        requestedAt,
                        worktreePath,
                        scriptId: setupResult.scriptId,
                        scriptName: setupResult.scriptName,
                        terminalId: setupResult.terminalId,
                      }),
              }),
            );
          progress = yield* input.commandPreprocessing.markCompleted(command, "setup-completed");
          yield* track(tracker.stageStatus(command.threadId, "setup-script", "done"));
        });

      const bootstrapProgram = Effect.gen(function* () {
        if (bootstrap?.createThread && !progress.threadCreated) {
          // #region motel debug
          // TODO: Remove after production skill selection is confirmed working.
          yield* Effect.logInfo("motel debug: bootstrap skill selection", {
            "debug.session": "skill-bootstrap-20260907",
            "debug.hypothesis": "bootstrap-drops-selected-packs",
            "debug.step": "before-thread-create",
            requestedPackIds: bootstrap.createThread.skillPackIds,
          });
          // #endregion motel debug
          const bootstrapStart = yield* Effect.all(
            {
              created: dispatchCommand({
                type: "thread.create",
                commandId: preprocessingCommandId(command, "thread-create"),
                threadId: command.threadId,
                projectId: bootstrap.createThread.projectId,
                title: bootstrap.createThread.title,
                modelSelection: bootstrap.createThread.modelSelection,
                runtimeMode: bootstrap.createThread.runtimeMode,
                interactionMode: bootstrap.createThread.interactionMode,
                ...(bootstrap.createThread.skillPackIds !== undefined
                  ? { skillPackIds: bootstrap.createThread.skillPackIds }
                  : {}),
                branch: bootstrap.createThread.branch,
                worktreePath: bootstrap.createThread.worktreePath,
                workspaceId: bootstrap.createThread.workspaceId ?? null,
                createdAt: bootstrap.createThread.createdAt,
              }),
              naming: generateWorkspaceNaming,
            },
            {
              concurrency: "unbounded",
            },
          );
          workspaceNaming = bootstrapStart.naming;
          yield* input.threadDeletionReactor.drainThrough(bootstrapStart.created.sequence);
          progress = yield* input.commandPreprocessing.markCompleted(command, "thread-created");
        }

        if (bootstrap?.createThread && progress.threadCreated) {
          // Deterministic child receipts let a reconnect resume without duplicating the message.
          yield* dispatchCommand({
            type: "thread.message.user.append",
            commandId: preprocessingCommandId(command, "bootstrap-message"),
            threadId: command.threadId,
            message: command.message,
            createdAt: command.createdAt,
          });
          if (tracked) {
            const snapshot = yield* tracker.get(command.threadId);
            if (snapshot) yield* input.recordWorktreeSetup(snapshot);
            yield* setPreparingSession("starting");
            preparingSessionSet = true;
          }
        }

        if (prepareWorkspace) {
          if (workspaceNaming === undefined) {
            const thread = yield* input.projectionSnapshotQuery
              .getThreadShellById(command.threadId)
              .pipe(
                Effect.mapError((cause) =>
                  toDispatchCommandError(cause, "Failed to read thread before workspace naming"),
                ),
              );
            workspaceNaming = Option.match(thread, {
              onNone: () => undefined,
              onSome: (currentThread) =>
                canReplaceThreadTitle(currentThread.title, provisionalTitle)
                  ? undefined
                  : ({
                      threadTitle: currentThread.title,
                      workspaceNameSeed: currentThread.title,
                      generated: false,
                    } satisfies BootstrapWorkspaceNaming),
            });
            workspaceNaming ??= yield* generateWorkspaceNaming;
          }

          if (workspaceNaming?.generated) {
            yield* dispatchCommand({
              type: "thread.meta.update",
              commandId: preprocessingCommandId(command, "thread-bootstrap-title"),
              threadId: command.threadId,
              title: workspaceNaming.threadTitle,
              titleMode: "automatic",
              expectedTitle: provisionalTitle,
            });
          }

          // WorkspaceService owns git, jj, copied and isolated workspaces. It
          // currently exposes one preparation operation, so report no invented percentages.
          yield* track(tracker.stageStatus(command.threadId, "checkout", "running"));
          const preparedWorkspace = yield* prepareThreadWorkspace({
            threadId: command.threadId,
            request: {
              ...prepareWorkspace,
              ...(workspaceNaming ? { displayNameSeed: workspaceNaming.workspaceNameSeed } : {}),
            },
          });
          targetWorktreePath = preparedWorkspace.compatibilityWorktreePath;
          yield* track(
            tracker.update(command.threadId, (snapshot) => ({
              ...snapshot,
              branch: preparedWorkspace.compatibilityBranch,
              worktreePath: targetWorktreePath,
            })),
          );
          yield* track(tracker.stageStatus(command.threadId, "checkout", "done"));
          if (!progress.workspacePrepared) {
            yield* dispatchCommand({
              type: "thread.meta.update",
              commandId: preprocessingCommandId(command, "thread-workspace-meta"),
              threadId: command.threadId,
              branch: preparedWorkspace.compatibilityBranch,
              worktreePath: targetWorktreePath,
              workspaceId: preparedWorkspace.workspace.id,
            });
            if (targetWorktreePath) yield* refreshGitStatus(targetWorktreePath);
            progress = yield* input.commandPreprocessing.markCompleted(
              command,
              "workspace-prepared",
            );
          }
        }

        yield* runSetupProgram();

        // Bootstrap remains in the durable envelope fingerprint even though the
        // decider intentionally excludes it from emitted events.
        yield* track(tracker.stageStatus(command.threadId, "agent", "running"));
        yield* track(tracker.markUncancellable(command.threadId));
        const result = yield* Effect.uninterruptible(dispatchCommand(command));
        yield* track(tracker.stageStatus(command.threadId, "agent", "done"));
        yield* finish("done");
        return result;
      });

      const settledProgram = bootstrapProgram.pipe(
        Effect.interruptible,
        Effect.catchCause((cause) => {
          const error = Cause.squash(cause);
          return Effect.gen(function* () {
            const cancelled = Cause.hasInterruptsOnly(cause);
            const detail = cancelled
              ? "Workspace setup cancelled."
              : setupFailureDescription(error);
            if (cancelled && progress.setup.status === "claimed") {
              yield* input.terminalManager
                .close({
                  threadId: command.threadId,
                  terminalId: `setup-${preprocessingCommandId(command, "setup-run")}`,
                })
                .pipe(Effect.ignoreCause({ log: true }));
            }
            yield* finish(cancelled ? "cancelled" : "failed", detail);
            const bootstrapThreadDisposition =
              bootstrap?.createThread && progress.threadCreated && !progress.workspacePrepared
                ? yield* dispatchCommand({
                    type: "thread.delete",
                    commandId: preprocessingCommandId(command, "bootstrap-thread-cleanup"),
                    threadId: command.threadId,
                  }).pipe(
                    Effect.as("deleted" as const),
                    Effect.tapError((cleanupCause) =>
                      Effect.logWarning(
                        "failed to clean up bootstrap thread after dispatch error",
                        {
                          threadId: command.threadId,
                          cause: cleanupCause,
                        },
                      ),
                    ),
                    Effect.orElseSucceed(() => undefined),
                  )
                : undefined;
            if (!bootstrapThreadDisposition && preparingSessionSet) {
              yield* setPreparingSession("error", detail).pipe(Effect.ignoreCause({ log: true }));
            }
            return yield* Effect.fail(
              isOrchestrationDispatchCommandError(error)
                ? error
                : new OrchestrationDispatchCommandError({
                    message: detail,
                    cause,
                    ...(bootstrapThreadDisposition ? { bootstrapThreadDisposition } : {}),
                  }),
            );
          });
        }),
        Effect.uninterruptible,
      );
      if (!tracked) return yield* settledProgram;
      // Register cancellation before the child can emit progress. The detached
      // parent owns the command lock until this child and its cleanup settle.
      const fiber = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();
          const fiber = yield* Deferred.await(ready).pipe(
            Effect.andThen(settledProgram),
            Effect.forkDetach,
          );
          yield* tracker.begin({
            threadId: command.threadId,
            branch: bootstrap?.prepareWorktree?.branch ?? null,
            baseRef:
              prepareWorkspace?.roots.find((root) => root.role === "primary")?.baseRevision ?? null,
            stages: ["checkout", "setup-script", "agent"],
            fiber,
          });
          yield* Deferred.succeed(ready, undefined);
          return fiber;
        }),
      );
      return yield* Fiber.join(fiber);
    });

  // Disconnecting only stops waiting. The full locked operation must survive,
  // otherwise a retry could enter preprocessing while the first setup still runs.
  const surviveDisconnect = <A, E, R>(
    command: { readonly type: string; readonly bootstrap?: unknown },
    effect: Effect.Effect<A, E, R>,
  ) =>
    command.type === "thread.turn.start" && command.bootstrap
      ? effect.pipe(Effect.forkDetach, Effect.flatMap(Fiber.join))
      : effect;

  const dispatchNormalizedCommandUnlocked = (
    normalizedCommand: OrchestrationCommand,
    performDeferredPreprocessing: Effect.Effect<
      void,
      OrchestrationDispatchCommandError
    > = Effect.void,
  ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> => {
    const dispatchAfterInitialMiss = input.startup.enqueueCommand(
      input.orchestrationEngine.resolveReceipt(normalizedCommand).pipe(
        Effect.flatMap(
          Option.match({
            onSome: Effect.succeed,
            onNone: () =>
              Effect.gen(function* () {
                yield* ProjectCloneTracker.rejectCommandsDuringClone(
                  input.projectCloneTracker,
                  normalizedCommand,
                );
                let progress = yield* input.commandPreprocessing.claim(normalizedCommand);
                if (!progress.deferredPreprocessingCompleted) {
                  yield* performDeferredPreprocessing;
                  progress = yield* input.commandPreprocessing.markCompleted(
                    normalizedCommand,
                    "deferred-preprocessing-completed",
                  );
                }
                if (normalizedCommand.type === "thread.turn.start" && normalizedCommand.bootstrap) {
                  return yield* dispatchBootstrapTurnStart(normalizedCommand, progress);
                }
                return yield* dispatchCommand(normalizedCommand);
              }),
          }),
        ),
      ),
    );

    return input.orchestrationEngine.resolveReceipt(normalizedCommand).pipe(
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () => dispatchAfterInitialMiss,
        }),
      ),
      Effect.tap(({ sequence }) =>
        normalizedCommand.type === "thread.create"
          ? input.threadDeletionReactor.drainThrough(sequence)
          : Effect.void,
      ),
      Effect.mapError((cause) =>
        toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
      ),
    );
  };

  const dispatchNormalizedCommand = (
    command: OrchestrationCommand,
    performDeferredPreprocessing: Effect.Effect<
      void,
      OrchestrationDispatchCommandError
    > = Effect.void,
  ) =>
    surviveDisconnect(
      command,
      input.commandPreprocessing.withCommandLock(
        command.commandId,
        dispatchNormalizedCommandUnlocked(command, performDeferredPreprocessing),
        "threadId" in command ? command.threadId : undefined,
      ),
    );

  const bindSelectedWorkspace = (command: ClientOrchestrationCommand) =>
    Effect.gen(function* () {
      if (
        command.type === "thread.meta.update" &&
        (command.worktreePath !== undefined || command.workspaceId !== undefined)
      ) {
        const shell = yield* input.projectionSnapshotQuery
          .getThreadShellById(command.threadId)
          .pipe(
            Effect.mapError((cause) => toDispatchCommandError(cause, "Thread is unavailable.")),
          );
        if (Option.isNone(shell)) return command;
        const selected = yield* input.threadWorkspaceService
          .selectWorkspace({
            projectId: shell.value.projectId,
            workspaceId: command.workspaceId ?? null,
            checkoutPath: command.worktreePath ?? null,
          })
          .pipe(
            Effect.mapError((cause) => toDispatchCommandError(cause, "Workspace is unavailable.")),
          );
        return {
          ...command,
          workspaceId: selected?.workspace.id ?? null,
          ...(selected ? { worktreePath: selected.compatibilityWorktreePath } : {}),
        };
      }
      const selection =
        command.type === "thread.create"
          ? command
          : command.type === "thread.turn.start"
            ? command.bootstrap?.createThread
            : undefined;
      if (!selection || (!selection.worktreePath && !selection.workspaceId)) return command;
      const selected = yield* input.threadWorkspaceService
        .selectWorkspace({
          projectId: selection.projectId,
          workspaceId: selection.workspaceId ?? null,
          checkoutPath: selection.worktreePath,
        })
        .pipe(
          Effect.mapError((cause) => toDispatchCommandError(cause, "Workspace is unavailable.")),
        );
      if (!selected) return command;
      const binding = {
        workspaceId: selected.workspace.id,
        worktreePath: selected.compatibilityWorktreePath,
      };
      if (command.type === "thread.create") return { ...command, ...binding };
      if (command.type === "thread.turn.start" && command.bootstrap?.createThread) {
        return {
          ...command,
          bootstrap: {
            ...command.bootstrap,
            createThread: { ...command.bootstrap.createThread, ...binding },
          },
        };
      }
      return command;
    });

  const dispatch = (command: ClientOrchestrationCommand) =>
    Effect.gen(function* () {
      const receivedAt = yield* input.commandPreprocessing.getReceivedAt(command.commandId);
      const preparedCommand = yield* prepareDispatchCommand(
        yield* bindSelectedWorkspace(command),
        receivedAt,
      );
      const normalizedCommand = preparedCommand.command;
      const archiveCommand =
        normalizedCommand.type === "thread.archive" ? normalizedCommand : undefined;
      const shouldStopSessionAfterCommand = archiveCommand
        ? yield* input.projectionSnapshotQuery.getThreadShellById(archiveCommand.threadId).pipe(
            Effect.map(
              Option.match({
                onNone: () => false,
                onSome: (thread) => thread.session !== null && thread.session.status !== "stopped",
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to read thread session state before session-stop check", {
                threadId: archiveCommand.threadId,
                cause,
              }).pipe(Effect.as(false)),
            ),
          )
        : false;

      const result = yield* dispatchNormalizedCommandUnlocked(
        normalizedCommand,
        preparedCommand.performDeferredPreprocessing,
      ).pipe(Effect.tapError(() => cleanupFailedUploadedAttachments(command, normalizedCommand)));
      if (input.onCommandDispatched) {
        yield* input.onCommandDispatched(normalizedCommand);
      }

      if (archiveCommand) {
        if (shouldStopSessionAfterCommand) {
          yield* Effect.gen(function* () {
            const stopCommand = yield* normalizeDispatchCommand({
              type: "thread.session.stop",
              commandId: CommandId.make(`session-stop-for-archive:${archiveCommand.commandId}`),
              threadId: archiveCommand.threadId,
              createdAt: yield* nowIso,
            });
            yield* dispatchNormalizedCommand(stopCommand);
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to stop provider session during archive", {
                threadId: archiveCommand.threadId,
                cause,
              }),
            ),
          );
        }

        yield* input.terminalManager.close({ threadId: archiveCommand.threadId }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to close thread terminals after archive", {
              threadId: archiveCommand.threadId,
              error: error.message,
            }),
          ),
        );
      }
      return result;
    }).pipe(
      (effect) =>
        input.commandPreprocessing.withCommandLock(
          command.commandId,
          effect,
          "threadId" in command ? command.threadId : undefined,
        ),
      (effect) => surviveDisconnect(command, effect),
      Effect.mapError((cause) =>
        isOrchestrationDispatchCommandError(cause)
          ? cause
          : new OrchestrationDispatchCommandError({
              message: "Failed to dispatch orchestration command",
              cause,
            }),
      ),
    );

  return { dispatch, dispatchNormalizedCommand };
}
