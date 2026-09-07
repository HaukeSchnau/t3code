import { CommandPreprocessingCoordinator } from "../orchestration/Services/CommandPreprocessingCoordinator.ts";
import { ThreadWorkspaceService } from "../workspace/ThreadWorkspaceService.ts";
import type {
  SkillPackId,
  ThreadWorkspaceId,
  ThreadTitleMode,
  ThreadSkillScope,
  OrchestrationNotificationOrigin,
} from "@t3tools/contracts";
import {
  CommandId,
  type ChatAttachment,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2ThreadProjection,
  type ProviderInteractionMode,
  ProjectId,
  type RunId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { makeProviderFailure } from "./ProviderFailure.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export type ThreadLaunchWorkspaceStrategy =
  | { readonly type: "root"; readonly branch?: string | undefined }
  | {
      readonly type: "existing_worktree";
      readonly worktreePath: string;
      readonly branch?: string | undefined;
    }
  | {
      readonly type: "worktree";
      readonly baseRef: string;
      readonly branch?: string | undefined;
      readonly startFromOrigin?: boolean | undefined;
    };

export interface ThreadLaunchInitialMessage {
  readonly origin?: OrchestrationNotificationOrigin | undefined;
  readonly messageId?: MessageId | undefined;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}

export interface ThreadLaunchInput {
  readonly workspaceId?: ThreadWorkspaceId | null | undefined;
  readonly titleMode?: ThreadTitleMode | undefined;
  readonly skillScope?: ThreadSkillScope | undefined;
  readonly skillPackIds?: ReadonlyArray<SkillPackId> | undefined;
  readonly commandId: CommandId;
  readonly threadId?: ThreadId | undefined;
  readonly reuseExistingThread?: boolean | undefined;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly generateTitle?: boolean | undefined;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspaceStrategy: ThreadLaunchWorkspaceStrategy;
  readonly initialMessage?: ThreadLaunchInitialMessage | undefined;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

export interface ThreadLaunchResult {
  readonly threadId: ThreadId;
  readonly projection: OrchestrationV2ThreadProjection;
  readonly resumed: boolean;
}

export class ThreadLaunchError extends Schema.TaggedErrorClass<ThreadLaunchError>()(
  "ThreadLaunchError",
  {
    operation: Schema.Literals([
      "resolve-project",
      "read-receipt",
      "generate-metadata",
      "provision-worktree",
      "run-setup-script",
      "create-thread",
      "update-thread",
      "dispatch-message",
      "release-run",
      "fail-run",
    ]),
    commandId: CommandId,
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread launch ${this.commandId} failed during ${this.operation}.`;
  }
}

export class ThreadLaunchService extends Context.Service<
  ThreadLaunchService,
  {
    readonly launch: (
      input: ThreadLaunchInput,
    ) => Effect.Effect<ThreadLaunchResult, ThreadLaunchError>;
  }
>()("t3/orchestration-v2/ThreadLaunchService") {}

const isThreadLaunchError = Schema.is(ThreadLaunchError);

function failureDetail(error: unknown): string {
  if (isThreadLaunchError(error)) {
    const cause = error.cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    return `Workspace preparation failed during ${error.operation.replaceAll("-", " ")}: ${detail}`;
  }
  return `Workspace preparation failed: ${error instanceof Error ? error.message : String(error)}`;
}

export const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const workspaces = yield* ThreadWorkspaceService;
  const preprocessing = yield* CommandPreprocessingCoordinator;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const preparationScope = yield* Scope.make("sequential");
  const scheduledLaunches = yield* Ref.make<ReadonlySet<CommandId>>(new Set());
  yield* Effect.addFinalizer(() => Scope.close(preparationScope, Exit.void));

  const mapError =
    (input: ThreadLaunchInput, operation: ThreadLaunchError["operation"], threadId?: ThreadId) =>
    (cause: unknown) =>
      new ThreadLaunchError({
        operation,
        commandId: input.commandId,
        projectId: input.projectId,
        ...(threadId === undefined ? {} : { threadId }),
        cause,
      });

  const readReceipt = (input: ThreadLaunchInput, commandId: CommandId) =>
    receipts
      .getByCommandId(commandId)
      .pipe(Effect.mapError(mapError(input, "read-receipt", input.threadId)));

  const validateReusableThread = Effect.fn("ThreadLaunchService.validateReusableThread")(function* (
    input: ThreadLaunchInput,
    threadId: ThreadId,
  ) {
    const projection = yield* threads
      .getThreadProjection(threadId)
      .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
    if (
      projection.thread.projectId !== input.projectId ||
      projection.thread.archivedAt !== null ||
      projection.thread.deletedAt !== null ||
      projection.messages.length > 0 ||
      projection.runs.length > 0
    ) {
      return yield* mapError(
        input,
        "update-thread",
        threadId,
      )("Only an empty active thread in the target project can change workspace during launch.");
    }
  });

  const prepareInBackground = Effect.fn("ThreadLaunchService.prepareInBackground")(function* (
    input: ThreadLaunchInput,
    threadId: ThreadId,
    runId: RunId | null,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError(mapError(input, "resolve-project", threadId)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(mapError(input, "resolve-project", threadId)("Project no longer exists.")),
          onSome: Effect.succeed,
        }),
      ),
    );

    let branch = input.workspaceStrategy.branch ?? null;
    let worktreePath =
      input.workspaceStrategy.type === "existing_worktree"
        ? input.workspaceStrategy.worktreePath
        : null;
    let workspaceId = input.workspaceId ?? null;
    if (input.workspaceStrategy.type === "worktree") {
      if (runId !== null) {
        yield* threads
          .dispatch({
            type: "prepared-run.progress",
            commandId: CommandId.make(`${input.commandId}:progress:worktree`),
            threadId,
            runId,
            phase: "worktree",
          })
          .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
      }
      const prepared = yield* workspaces
        .prepareWorkspace({
          threadId,
          kind: "auto",
          displayNameSeed: input.title,
          roots: [
            {
              projectId: input.projectId,
              sourcePath: project.workspaceRoot,
              role: "primary",
              baseRevision: input.workspaceStrategy.baseRef,
              ...(input.workspaceStrategy.startFromOrigin === undefined
                ? {}
                : { startFromOrigin: input.workspaceStrategy.startFromOrigin }),
            },
          ],
        })
        .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)));
      workspaceId = prepared.workspace.id;
      worktreePath = prepared.compatibilityWorktreePath;
      branch = prepared.compatibilityBranch;
    }

    yield* threads
      .dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`${input.commandId}:workspace`),
        threadId,
        branch,
        worktreePath,
        workspaceId,
      })
      .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));

    const workspaceCwd = yield* workspaces
      .resolvePrimaryCwd({ workspaceId, threadId, projectId: input.projectId })
      .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)));
    const cwd = workspaceCwd ?? worktreePath ?? project.workspaceRoot;
    if (runId !== null) {
      yield* threads
        .dispatch({
          type: "prepared-run.progress",
          commandId: CommandId.make(`${input.commandId}:progress:setup`),
          threadId,
          runId,
          phase: "setup",
        })
        .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
    }
    const envelope = { ...input, type: "thread.launch" as const, threadId };
    const setupInput = {
      threadId,
      projectId: input.projectId,
      projectCwd: project.workspaceRoot,
      worktreePath: cwd,
      preferredTerminalId: `setup-${input.commandId}`,
      project: { workspaceRoot: project.workspaceRoot, scripts: project.scripts },
    };
    let progress = yield* preprocessing
      .claim(envelope)
      .pipe(Effect.mapError(mapError(input, "run-setup-script", threadId)));
    if (progress.setup.status !== "completed") {
      if (progress.setup.status === "pending") {
        const resolution = yield* setupScripts
          .resolveForThread(setupInput)
          .pipe(Effect.mapError(mapError(input, "run-setup-script", threadId)));
        if (resolution.status === "resolved") {
          progress = yield* preprocessing
            .claimSetup(envelope, resolution.execution)
            .pipe(Effect.mapError(mapError(input, "run-setup-script", threadId)));
        }
      }
      yield* setupScripts
        .runForThread({
          ...setupInput,
          reconcileClaimedLaunch: true,
          ...(progress.setup.status === "claimed"
            ? { expectedExecution: progress.setup.execution }
            : {}),
        })
        .pipe(Effect.mapError(mapError(input, "run-setup-script", threadId)));
      yield* preprocessing
        .markCompleted(envelope, "setup-completed")
        .pipe(Effect.mapError(mapError(input, "run-setup-script", threadId)));
    }

    if (runId !== null) {
      yield* threads
        .dispatch({
          type: "prepared-run.release",
          commandId: CommandId.make(`${input.commandId}:release`),
          threadId,
          runId,
        })
        .pipe(Effect.mapError(mapError(input, "release-run", threadId)));
    }
  });

  const failPreparedRun = (
    input: ThreadLaunchInput,
    threadId: ThreadId,
    runId: RunId | null,
    cause: unknown,
  ) =>
    runId === null
      ? Effect.logWarning("Thread workspace preparation failed", {
          commandId: input.commandId,
          threadId,
          cause,
        })
      : threads
          .dispatch({
            type: "prepared-run.fail",
            commandId: CommandId.make(`${input.commandId}:fail`),
            threadId,
            runId,
            failure: makeProviderFailure({
              cause,
              message: failureDetail(cause),
              class: "validation_error",
              retryable: false,
            }),
          })
          .pipe(
            Effect.mapError(mapError(input, "fail-run", threadId)),
            Effect.catchCause((persistCause) =>
              Effect.logWarning("Failed to persist thread workspace preparation failure", {
                commandId: input.commandId,
                threadId,
                cause,
                persistCause,
              }),
            ),
          );

  const reservePreparation = (commandId: CommandId) =>
    Ref.modify(scheduledLaunches, (scheduled) => {
      if (scheduled.has(commandId)) return [false, scheduled] as const;
      const next = new Set(scheduled);
      next.add(commandId);
      return [true, next] as const;
    });

  const releasePreparation = (commandId: CommandId) =>
    Ref.update(scheduledLaunches, (scheduled) => {
      const next = new Set(scheduled);
      next.delete(commandId);
      return next;
    });

  const schedulePreparation = Effect.fn("ThreadLaunchService.schedulePreparation")(function* (
    input: ThreadLaunchInput,
    threadId: ThreadId,
    runId: RunId | null,
  ) {
    yield* prepareInBackground(input, threadId, runId).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : failPreparedRun(input, threadId, runId, Cause.squash(cause)),
      ),
      Effect.ensuring(releasePreparation(input.commandId)),
      Effect.forkIn(preparationScope),
    );
  });

  const launch: ThreadLaunchService["Service"]["launch"] = Effect.fn("ThreadLaunchService.launch")(
    function* (requestedInput) {
      const input = {
        ...requestedInput,
        threadId:
          requestedInput.threadId ?? ThreadId.make(`thread:launch:${requestedInput.commandId}`),
      };
      yield* preprocessing
        .claim({ ...input, type: "thread.launch" })
        .pipe(Effect.mapError(mapError(input, "read-receipt", input.threadId)));
      const project = yield* projects.getById(input.projectId).pipe(
        Effect.mapError(mapError(input, "resolve-project")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(mapError(input, "resolve-project")("Project not found.")),
            onSome: Effect.succeed,
          }),
        ),
      );
      if (requestedInput.reuseExistingThread === true && requestedInput.threadId === undefined) {
        return yield* mapError(
          input,
          "update-thread",
        )("Reusing an existing thread requires a thread id.");
      }

      const launchReceipt = yield* readReceipt(input, input.commandId);
      return yield* Effect.gen(function* () {
        const candidateThreadId = input.threadId;

        if (input.reuseExistingThread === true && Option.isNone(launchReceipt)) {
          yield* validateReusableThread(input, candidateThreadId);
        }

        const initialBranch = input.workspaceStrategy.branch ?? null;
        const initialWorktreePath =
          input.workspaceStrategy.type === "existing_worktree"
            ? input.workspaceStrategy.worktreePath
            : null;
        const claimDispatch =
          input.reuseExistingThread === true
            ? threads.dispatch({
                type: "thread.metadata.update",
                commandId: input.commandId,
                threadId: candidateThreadId,
              })
            : threads.dispatch({
                type: "thread.create",
                commandId: input.commandId,
                threadId: candidateThreadId,
                projectId: input.projectId,
                title: input.title,
                skillPackIds: input.skillPackIds,
                workspaceId: input.workspaceId,
                titleMode: input.titleMode,
                skillScope: input.skillScope,
                modelSelection: input.modelSelection,
                runtimeMode: input.runtimeMode,
                interactionMode: input.interactionMode,
                branch: initialBranch,
                worktreePath: initialWorktreePath,
                createdBy: input.createdBy,
                creationSource: input.creationSource,
              });
        const claimed = yield* claimDispatch.pipe(
          Effect.mapError(
            mapError(
              input,
              input.reuseExistingThread === true ? "update-thread" : "create-thread",
              candidateThreadId,
            ),
          ),
        );
        const threadId =
          claimed.storedEvents.find((stored) => stored.event.type.startsWith("thread."))?.event
            .threadId ?? candidateThreadId;
        if (project.id !== input.projectId) {
          return yield* mapError(input, "resolve-project", threadId)("Project identity changed.");
        }

        let runId: RunId | null = null;
        let messageWasAlreadyAccepted = false;
        if (input.initialMessage !== undefined) {
          const messageCommandId = CommandId.make(`${input.commandId}:initial-message`);
          const messageReceipt = yield* readReceipt(input, messageCommandId);
          messageWasAlreadyAccepted = Option.isSome(messageReceipt);
          const messageId =
            input.initialMessage.messageId ?? MessageId.make(`${input.commandId}:initial-message`);
          const dispatched = yield* threads
            .dispatch({
              type: "message.dispatch",
              commandId: messageCommandId,
              threadId,
              messageId,
              text: input.initialMessage.text,
              origin: input.initialMessage.origin,
              attachments: input.initialMessage.attachments,
              ...(input.generateTitle === true ? { titleSeed: input.title } : {}),
              modelSelection: input.modelSelection,
              dispatchMode: { type: "defer_start" },
              createdBy: input.createdBy,
              creationSource: input.creationSource,
            })
            .pipe(Effect.mapError(mapError(input, "dispatch-message", threadId)));
          const runCreated = dispatched.storedEvents.find(
            (stored) => stored.event.type === "run.created",
          );
          runId = runCreated?.event.type === "run.created" ? runCreated.event.payload.id : null;
          if (runId === null) {
            return yield* mapError(
              input,
              "dispatch-message",
              threadId,
            )("Initial message was accepted without a durable run.");
          }
        }

        const projection = yield* threads
          .getThreadProjection(threadId)
          .pipe(Effect.mapError(mapError(input, "create-thread", threadId)));
        const runIsPreparing =
          runId !== null &&
          projection.runs.some((run) => run.id === runId && run.status === "preparing");
        const shouldSchedule = runId === null ? Option.isNone(launchReceipt) : runIsPreparing;
        if (shouldSchedule) {
          const ownsPreparation = yield* reservePreparation(input.commandId);
          if (ownsPreparation) {
            yield* Effect.gen(function* () {
              const preparationStillRequired =
                runId === null
                  ? true
                  : yield* threads.getThreadProjection(threadId).pipe(
                      Effect.map((current) =>
                        current.runs.some((run) => run.id === runId && run.status === "preparing"),
                      ),
                      Effect.mapError(mapError(input, "update-thread", threadId)),
                    );
              if (preparationStillRequired) {
                yield* schedulePreparation(input, threadId, runId);
              } else {
                yield* releasePreparation(input.commandId);
              }
            }).pipe(Effect.onError(() => releasePreparation(input.commandId)));
          }
        }

        return {
          threadId,
          projection,
          resumed: Option.isSome(launchReceipt) || messageWasAlreadyAccepted,
        };
      });
    },
  );

  return ThreadLaunchService.of({ launch });
});

export const layer = Layer.effect(ThreadLaunchService, make);
