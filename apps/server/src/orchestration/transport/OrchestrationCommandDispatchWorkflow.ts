import {
  EventId,
  OrchestrationDispatchCommandError,
  type LegacyOutboxCommand,
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
  type CommandPreprocessingProgress,
  CommandPreprocessingCoordinator,
  preprocessingCommandId,
} from "../Services/CommandPreprocessingCoordinator.ts";
import { canReplaceThreadTitle, DEFAULT_THREAD_TITLE } from "../threadTitles.ts";
import type { ThreadCoordinationBackend } from "../../mcp/toolkits/thread-orchestration/V2Bridge.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import type * as ServerSettings from "../../serverSettings.ts";
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
};

export interface PreparedLegacyOutboxCommand {
  readonly receiptCommand?: LegacyOutboxCommand | OrchestrationCommand;
  /** The native command body, with upload-only attachments materialized. */
  readonly command: OrchestrationCommand;
  /** Side effects that are safe to perform after receipt validation. */
  readonly performDeferredPreprocessing: Effect.Effect<void, OrchestrationDispatchCommandError>;
}

type LegacyTurnStartCommand = Extract<LegacyOutboxCommand, { type: "thread.turn.start" }>;
type NativeTurnStartCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
type LegacyOrNativeTurnStartCommand = LegacyTurnStartCommand | NativeTurnStartCommand;

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
  readonly backend: ThreadCoordinationBackend["Service"];
  readonly commandPreprocessing: CommandPreprocessingCoordinator["Service"];
  readonly textGeneration: TextGeneration.TextGeneration["Service"];
  readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
  readonly threadWorkspaceService: ThreadWorkspaceService.ThreadWorkspaceService["Service"];
  readonly projectSetupScriptRunner: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"];
  readonly vcsStatusBroadcaster: VcsStatusBroadcaster.VcsStatusBroadcaster["Service"];
  readonly prepareLegacyOutboxCommand: (
    original: LegacyOutboxCommand,
  ) => Effect.Effect<PreparedLegacyOutboxCommand, OrchestrationDispatchCommandError>;
  readonly onCommandDispatched?: (
    command: OrchestrationCommand,
  ) => Effect.Effect<void, never, never>;
}) {
  const dispatchCommand = input.backend.engine.dispatch;
  const dispatchWithinCommandLock = input.backend.engine.dispatchWithinCommandLock;
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
    readonly parentCommand: LegacyOrNativeTurnStartCommand;
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
    command: LegacyOrNativeTurnStartCommand,
    preparedCommand: NativeTurnStartCommand,
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
            attachments: preparedCommand.message.attachments,
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
          const bootstrapStart = yield* Effect.all(
            {
              created: dispatchCommand({
                type: "thread.create",
                commandId: preprocessingCommandId(command, "thread-create"),
                threadId: command.threadId,
                projectId: bootstrap.createThread.projectId,
                title: bootstrap.createThread.title,
                titleMode: bootstrap.createThread.titleMode,
                skillScope: bootstrap.createThread.skillScope,
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
          progress = yield* input.commandPreprocessing.markCompleted(command, "thread-created");
        }

        if (prepareWorkspace) {
          if (workspaceNaming === undefined) {
            const thread = yield* input.backend.snapshotQuery
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

          const preparedWorkspace = yield* prepareThreadWorkspace({
            threadId: command.threadId,
            request: {
              ...prepareWorkspace,
              ...(workspaceNaming ? { displayNameSeed: workspaceNaming.workspaceNameSeed } : {}),
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
        // The original command id is already locked by the replay workflow.
        // Re-entering `engine.dispatch` here would wait forever on the same
        // non-reentrant coordinator lock, and dropping bootstrap would make
        // the final receipt unverifiable. Dispatch the exact envelope through
        // the lock-free backend entrypoint.
        return yield* dispatchWithinCommandLock(preparedCommand, command);
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
  ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
    input.commandPreprocessing
      .withCommandLock(
        normalizedCommand.commandId,
        input.backend.engine.resolveReceipt(normalizedCommand).pipe(
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
                    return yield* dispatchBootstrapTurnStart(
                      normalizedCommand,
                      normalizedCommand,
                      progress,
                    );
                  }
                  return yield* dispatchWithinCommandLock(normalizedCommand, normalizedCommand);
                }),
            }),
          ),
        ),
      )
      .pipe(
        Effect.mapError((cause) =>
          toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
        ),
      );

  /**
   * Replays one pre-V2 durable outbox envelope. Receipt validation and the
   * preprocessing claim deliberately use the untouched client envelope. The
   * bootstrap command is therefore still part of its durable fingerprint when
   * the native V2 message dispatch is committed.
   */
  const replayLegacyOutbox = (original: LegacyOutboxCommand) =>
    input.commandPreprocessing
      .withCommandLock(
        original.commandId,
        Effect.gen(function* () {
          const prepared = yield* input.prepareLegacyOutboxCommand(original);
          const command = prepared.receiptCommand ?? original;
          const previous = yield* input.backend.engine.resolveReceipt(command);
          if (Option.isSome(previous)) return previous.value;
          let progress = yield* input.commandPreprocessing.claim(command);
          if (!progress.deferredPreprocessingCompleted) {
            yield* prepared.performDeferredPreprocessing;
            progress = yield* input.commandPreprocessing.markCompleted(
              command,
              "deferred-preprocessing-completed",
            );
          }
          const result =
            command.type === "thread.turn.start" &&
            command.bootstrap &&
            prepared.command.type === "thread.turn.start"
              ? yield* dispatchBootstrapTurnStart(command, prepared.command, progress)
              : yield* dispatchWithinCommandLock(prepared.command, command);
          if (input.onCommandDispatched) yield* input.onCommandDispatched(prepared.command);
          return result;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          toDispatchCommandError(cause, "Failed to replay legacy outbox command"),
        ),
        Effect.map(({ sequence }) => ({ sequence })),
      );

  return { replayLegacyOutbox, dispatch: replayLegacyOutbox, dispatchNormalizedCommand };
}
