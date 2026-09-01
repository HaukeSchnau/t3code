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
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
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
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
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
  readonly startup: ServerRuntimeStartup.ServerRuntimeStartup["Service"];
  readonly projectionSnapshotQuery: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape;
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
          if (!bootstrap?.runSetupScript || !targetWorktreePath) return;
          if (progress.setup.status === "completed") return;

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
              progress = yield* input.commandPreprocessing.markCompleted(
                command,
                "setup-completed",
              );
              return;
            }
            progress = yield* input.commandPreprocessing.claimSetup(command, resolution.execution);
          }
          if (progress.setup.status !== "claimed") return;

          const requestedAt = yield* nowIso;
          yield* input.projectSetupScriptRunner
            .runForThread({
              ...runnerInput,
              reconcileClaimedLaunch,
              expectedExecution: progress.setup.execution,
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
        });

      const bootstrapProgram = Effect.gen(function* () {
        if (bootstrap?.createThread && !progress.threadCreated) {
          const created = yield* dispatchCommand({
            type: "thread.create",
            commandId: preprocessingCommandId(command, "thread-create"),
            threadId: command.threadId,
            projectId: bootstrap.createThread.projectId,
            title: bootstrap.createThread.title,
            modelSelection: bootstrap.createThread.modelSelection,
            runtimeMode: bootstrap.createThread.runtimeMode,
            interactionMode: bootstrap.createThread.interactionMode,
            branch: bootstrap.createThread.branch,
            worktreePath: bootstrap.createThread.worktreePath,
            workspaceId: bootstrap.createThread.workspaceId ?? null,
            createdAt: bootstrap.createThread.createdAt,
          });
          yield* input.threadDeletionReactor.drainThrough(created.sequence);
          progress = yield* input.commandPreprocessing.markCompleted(command, "thread-created");
        }

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

        if (prepareWorkspace) {
          const preparedWorkspace = yield* prepareThreadWorkspace({
            threadId: command.threadId,
            request: {
              ...prepareWorkspace,
              ...(bootstrap?.createThread?.title
                ? { displayNameSeed: bootstrap.createThread.title }
                : {}),
            },
          });
          targetWorktreePath = preparedWorkspace.compatibilityWorktreePath;
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
        return yield* dispatchCommand(command);
      });

      return yield* bootstrapProgram.pipe(
        Effect.catchCause((cause) => {
          const error = Cause.squash(cause);
          return Effect.fail(
            isOrchestrationDispatchCommandError(error)
              ? error
              : new OrchestrationDispatchCommandError({
                  message:
                    error instanceof Error
                      ? error.message
                      : "Failed to bootstrap thread turn start.",
                  cause,
                }),
          );
        }),
      );
    });

  const dispatchNormalizedCommand = (
    normalizedCommand: OrchestrationCommand,
    performDeferredPreprocessing: Effect.Effect<
      void,
      OrchestrationDispatchCommandError
    > = Effect.void,
  ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> => {
    const dispatchAfterInitialMiss = input.commandPreprocessing.withCommandLock(
      normalizedCommand.commandId,
      input.startup.enqueueCommand(
        input.orchestrationEngine.resolveReceipt(normalizedCommand).pipe(
          Effect.flatMap(
            Option.match({
              onSome: Effect.succeed,
              onNone: () =>
                Effect.gen(function* () {
                  let progress = yield* input.commandPreprocessing.claim(normalizedCommand);
                  if (!progress.deferredPreprocessingCompleted) {
                    yield* performDeferredPreprocessing;
                    progress = yield* input.commandPreprocessing.markCompleted(
                      normalizedCommand,
                      "deferred-preprocessing-completed",
                    );
                  }
                  if (
                    normalizedCommand.type === "thread.turn.start" &&
                    normalizedCommand.bootstrap
                  ) {
                    return yield* dispatchBootstrapTurnStart(normalizedCommand, progress);
                  }
                  return yield* dispatchCommand(normalizedCommand);
                }),
            }),
          ),
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

  const dispatch = (command: ClientOrchestrationCommand) =>
    Effect.gen(function* () {
      const preparedCommand = yield* prepareDispatchCommand(command);
      const normalizedCommand = preparedCommand.command;
      const parkingCommand =
        normalizedCommand.type === "thread.archive" || normalizedCommand.type === "thread.settle"
          ? normalizedCommand
          : undefined;
      const shouldStopSessionAfterCommand = parkingCommand
        ? yield* input.projectionSnapshotQuery.getThreadShellById(parkingCommand.threadId).pipe(
            Effect.map(
              Option.match({
                onNone: () => false,
                onSome: (thread) => thread.session !== null && thread.session.status !== "stopped",
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to read thread session state before session-stop check", {
                threadId: parkingCommand.threadId,
                cause,
              }).pipe(Effect.as(false)),
            ),
          )
        : false;

      const result = yield* dispatchNormalizedCommand(
        normalizedCommand,
        preparedCommand.performDeferredPreprocessing,
      ).pipe(Effect.tapError(() => cleanupFailedUploadedAttachments(command, normalizedCommand)));
      if (input.onCommandDispatched) {
        yield* input.onCommandDispatched(normalizedCommand);
      }

      if (parkingCommand) {
        const parkingKind = parkingCommand.type === "thread.archive" ? "archive" : "settle";
        if (shouldStopSessionAfterCommand) {
          yield* Effect.gen(function* () {
            const stopCommand = yield* normalizeDispatchCommand({
              type: "thread.session.stop",
              commandId: CommandId.make(
                `session-stop-for-${parkingKind}:${parkingCommand.commandId}`,
              ),
              threadId: parkingCommand.threadId,
              createdAt: yield* nowIso,
              ...(parkingKind === "settle" ? { onlyIfSettled: true } : {}),
            });
            yield* dispatchNormalizedCommand(stopCommand);
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(`failed to stop provider session during ${parkingKind}`, {
                threadId: parkingCommand.threadId,
                cause,
              }),
            ),
          );
        }

        if (parkingCommand.type === "thread.archive") {
          yield* input.terminalManager.close({ threadId: parkingCommand.threadId }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to close thread terminals after archive", {
                threadId: parkingCommand.threadId,
                error: error.message,
              }),
            ),
          );
        }
      }
      return result;
    }).pipe(
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
