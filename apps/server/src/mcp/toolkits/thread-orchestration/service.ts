import {
  CommandId,
  EventId,
  MessageId,
  type ProjectId,
  ThreadId,
  ThreadOrchestrationError,
  type OrchestrationProject,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type ThreadOrchestrationCreateThreadInput,
  type ThreadOrchestrationCreateThreadResult,
  type ThreadOrchestrationForkThreadInput,
  type ThreadOrchestrationForkThreadResult,
  type ThreadOrchestrationListProjectsResult,
  type ThreadOrchestrationListThreadsInput,
  type ThreadOrchestrationListThreadsResult,
  type ThreadOrchestrationReadThreadInput,
  type ThreadOrchestrationRelationshipKind,
  type ThreadOrchestrationSendMessageInput,
  type ThreadOrchestrationSendMessageResult,
  type ThreadOrchestrationSetThreadTitleInput,
  type ThreadOrchestrationThreadDetail,
  type ThreadOrchestrationThreadSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadWorkspaceService from "../../../workspace/ThreadWorkspaceService.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type * as McpInvocationContext from "../../McpInvocationContext.ts";

const DEFAULT_THREAD_LIMIT = 20;
const MAX_THREAD_LIMIT = 100;

export class ThreadOrchestrationService extends Context.Service<
  ThreadOrchestrationService,
  {
    readonly listProjects: () => Effect.Effect<
      ThreadOrchestrationListProjectsResult,
      ThreadOrchestrationError
    >;
    readonly listThreads: (
      input: ThreadOrchestrationListThreadsInput,
    ) => Effect.Effect<ThreadOrchestrationListThreadsResult, ThreadOrchestrationError>;
    readonly readThread: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationReadThreadInput,
    ) => Effect.Effect<ThreadOrchestrationThreadDetail, ThreadOrchestrationError>;
    readonly createThread: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationCreateThreadInput,
    ) => Effect.Effect<ThreadOrchestrationCreateThreadResult, ThreadOrchestrationError>;
    readonly forkThread: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationForkThreadInput,
    ) => Effect.Effect<ThreadOrchestrationForkThreadResult, ThreadOrchestrationError>;
    readonly sendMessageToThread: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationSendMessageInput,
    ) => Effect.Effect<ThreadOrchestrationSendMessageResult, ThreadOrchestrationError>;
    readonly setThreadTitle: (
      scope: McpInvocationContext.McpInvocationScope,
      input: ThreadOrchestrationSetThreadTitleInput,
    ) => Effect.Effect<ThreadOrchestrationThreadSummary, ThreadOrchestrationError>;
  }
>()("t3/mcp/toolkits/thread-orchestration/service/ThreadOrchestrationService") {}

const toThreadOrchestrationError =
  (
    operation: string,
    input: { readonly threadId?: ThreadId; readonly projectId?: ProjectId } = {},
  ) =>
  (cause: unknown) =>
    new ThreadOrchestrationError({
      operation,
      message: `Thread orchestration operation '${operation}' failed.`,
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      cause,
    });

const compareUpdatedDesc = (
  left: { readonly updatedAt: string },
  right: { readonly updatedAt: string },
) => right.updatedAt.localeCompare(left.updatedAt);

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const makeId = <A>(crypto: Crypto.Crypto, prefix: string, make: (value: string) => A) =>
  crypto.randomUUIDv4.pipe(
    Effect.map((uuid) => make(`${prefix}:${uuid}`)),
    Effect.orDie,
  );

type ThreadSummarySource = OrchestrationThread | OrchestrationThreadShell;
type ProjectSummarySource = OrchestrationProject | OrchestrationProjectShell;

function statusForThread(thread: ThreadSummarySource): string {
  if ("deletedAt" in thread && thread.deletedAt !== null) return "deleted";
  if (thread.archivedAt !== null) return "archived";
  if (thread.session !== null) return thread.session.status;
  if (thread.latestTurn !== null) return thread.latestTurn.state;
  return "idle";
}

function summaryForThread(
  thread: ThreadSummarySource,
  project: ProjectSummarySource,
): ThreadOrchestrationThreadSummary {
  return {
    threadId: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    projectTitle: project.title,
    status: statusForThread(thread),
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    workspaceRoot: project.workspaceRoot,
    worktreePath: thread.worktreePath,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

function findProject(
  projects: ReadonlyArray<OrchestrationProject>,
  projectId: string,
): OrchestrationProject | undefined {
  return projects.find((project) => project.id === projectId && project.deletedAt === null);
}

function findThread(
  threads: ReadonlyArray<OrchestrationThread>,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return threads.find((thread) => thread.id === threadId && thread.deletedAt === null);
}

function trimMessagesForTurns(
  thread: OrchestrationThread,
  turnLimit: number | undefined,
): OrchestrationThread["messages"] {
  if (turnLimit === undefined) return thread.messages;
  let remainingUsers = turnLimit;
  let startIndex = thread.messages.length;
  while (startIndex > 0 && remainingUsers > 0) {
    startIndex -= 1;
    if (thread.messages[startIndex]?.role === "user") {
      remainingUsers -= 1;
    }
  }
  return thread.messages.slice(startIndex);
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const workspaceService = yield* ThreadWorkspaceService.ThreadWorkspaceService;
  const crypto = yield* Crypto.Crypto;

  const snapshot = snapshotQuery
    .getSnapshot()
    .pipe(Effect.mapError(toThreadOrchestrationError("snapshot")));
  const shellSnapshot = snapshotQuery
    .getShellSnapshot()
    .pipe(Effect.mapError(toThreadOrchestrationError("shell_snapshot")));

  const commandId = (tag: string) => makeId(crypto, `mcp:${tag}`, CommandId.make);
  const eventId = (tag: string) => makeId(crypto, `mcp:${tag}`, EventId.make);
  const messageId = (tag: string) => makeId(crypto, `mcp:${tag}`, MessageId.make);
  const threadId = (tag: string) => makeId(crypto, `mcp:${tag}`, ThreadId.make);

  const appendRelationship = (input: {
    readonly scope: McpInvocationContext.McpInvocationScope;
    readonly kind: ThreadOrchestrationRelationshipKind;
    readonly targetThreadId: ThreadId;
    readonly summary: string;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      const activity: OrchestrationThreadActivity = {
        id: yield* eventId("thread-relationship"),
        tone: "tool",
        kind: "thread-orchestration.relationship",
        summary: input.summary,
        payload: {
          kind: input.kind,
          actorThreadId: input.scope.threadId,
          targetThreadId: input.targetThreadId,
          createdAt: input.createdAt,
        },
        turnId: null,
        createdAt: input.createdAt,
      };
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: yield* commandId("thread-relationship"),
        threadId: input.targetThreadId,
        activity,
        createdAt: input.createdAt,
      });
    }).pipe(
      Effect.mapError(
        toThreadOrchestrationError("relationship.append", { threadId: input.targetThreadId }),
      ),
    );

  const resolveThreadSummary = (targetThreadId: ThreadId) =>
    Effect.gen(function* () {
      const model = yield* snapshot;
      const thread = findThread(model.threads, targetThreadId);
      if (!thread) {
        return yield* new ThreadOrchestrationError({
          operation: "thread.resolve",
          message: `Thread '${targetThreadId}' was not found.`,
          threadId: targetThreadId,
        });
      }
      const project = findProject(model.projects, thread.projectId);
      if (!project) {
        return yield* new ThreadOrchestrationError({
          operation: "thread.resolve",
          message: `Project '${thread.projectId}' for thread '${targetThreadId}' was not found.`,
          threadId: targetThreadId,
          projectId: thread.projectId,
        });
      }
      return summaryForThread(thread, project);
    });

  const listProjects = () =>
    shellSnapshot.pipe(
      Effect.map((model) => ({
        projects: model.projects.toSorted(compareUpdatedDesc).map((project) => ({
          projectId: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
          updatedAt: project.updatedAt,
        })),
      })),
    );

  const listThreads = (input: ThreadOrchestrationListThreadsInput) =>
    shellSnapshot.pipe(
      Effect.map((model) => {
        const query = input.query?.toLowerCase();
        const limit = Math.min(input.limit ?? DEFAULT_THREAD_LIMIT, MAX_THREAD_LIMIT);
        return {
          threads: model.threads
            .filter((thread) => thread.archivedAt === null)
            .flatMap((thread) => {
              const project = model.projects.find((candidate) => candidate.id === thread.projectId);
              if (!project) return [];
              const summary = summaryForThread(thread, project);
              if (
                query &&
                !summary.title.toLowerCase().includes(query) &&
                !summary.projectTitle.toLowerCase().includes(query) &&
                !summary.workspaceRoot.toLowerCase().includes(query)
              ) {
                return [];
              }
              return [summary];
            })
            .toSorted(compareUpdatedDesc)
            .slice(0, limit),
        };
      }),
    );

  const readThread = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationReadThreadInput,
  ) =>
    Effect.gen(function* () {
      const model = yield* snapshot;
      const thread = findThread(model.threads, input.threadId);
      if (!thread) {
        return yield* new ThreadOrchestrationError({
          operation: "read_thread",
          message: `Thread '${input.threadId}' was not found.`,
          threadId: input.threadId,
        });
      }
      const project = findProject(model.projects, thread.projectId);
      if (!project) {
        return yield* new ThreadOrchestrationError({
          operation: "read_thread",
          message: `Project '${thread.projectId}' for thread '${input.threadId}' was not found.`,
          threadId: input.threadId,
          projectId: thread.projectId,
        });
      }
      const createdAt = yield* nowIso;
      if (input.threadId !== scope.threadId) {
        yield* appendRelationship({
          scope,
          kind: "readBy",
          targetThreadId: input.threadId,
          summary: `Read by thread ${scope.threadId}.`,
          createdAt,
        });
      }
      return {
        thread: summaryForThread(thread, project),
        messages: trimMessagesForTurns(thread, input.turnLimit),
        activities: thread.activities,
        queuedMessageCount: thread.queuedMessages?.length ?? 0,
      };
    });

  const createThread = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationCreateThreadInput,
  ) =>
    Effect.gen(function* () {
      const model = yield* snapshot;
      const project = findProject(model.projects, input.target.projectId);
      if (!project) {
        return yield* new ThreadOrchestrationError({
          operation: "create_thread",
          message: `Project '${input.target.projectId}' was not found.`,
          projectId: input.target.projectId,
        });
      }

      const createdAt = yield* nowIso;
      const nextThreadId = yield* threadId("thread");
      const title = input.title ?? input.prompt.slice(0, 80);
      const selectedModel = input.modelSelection ?? project.defaultModelSelection;
      if (selectedModel === null) {
        return yield* new ThreadOrchestrationError({
          operation: "create_thread",
          message: `Project '${project.id}' does not have a default model selection.`,
          projectId: project.id,
        });
      }

      const prepared =
        input.target.environment.type === "worktree"
          ? yield* workspaceService
              .prepareWorkspace({
                threadId: nextThreadId,
                kind: "auto",
                roots: [
                  {
                    projectId: project.id,
                    sourcePath: project.workspaceRoot,
                    role: "primary",
                  },
                ],
                displayNameSeed: title,
                retentionPolicy: "explicit-delete",
              })
              .pipe(
                Effect.mapError(
                  toThreadOrchestrationError("create_thread.prepare_workspace", {
                    threadId: nextThreadId,
                    projectId: project.id,
                  }),
                ),
              )
          : undefined;

      const cleanupPreparedWorkspace =
        prepared === undefined
          ? Effect.void
          : workspaceService
              .deleteWorkspace({
                workspaceId: prepared.workspace.id,
                force: true,
              })
              .pipe(Effect.ignoreCause({ log: true }));

      yield* engine
        .dispatch({
          type: "thread.create",
          commandId: yield* commandId("thread-create"),
          threadId: nextThreadId,
          projectId: project.id,
          title,
          modelSelection: selectedModel,
          runtimeMode: input.runtimeMode ?? "full-access",
          interactionMode: input.interactionMode ?? "default",
          branch: prepared?.compatibilityBranch ?? null,
          worktreePath: prepared?.compatibilityWorktreePath ?? null,
          workspaceId: prepared?.workspace.id ?? null,
          createdAt,
        })
        .pipe(
          Effect.mapError(
            toThreadOrchestrationError("create_thread.dispatch", {
              threadId: nextThreadId,
              projectId: project.id,
            }),
          ),
          Effect.catch((error) =>
            cleanupPreparedWorkspace.pipe(Effect.flatMap(() => Effect.fail(error))),
          ),
        );

      yield* engine
        .dispatch({
          type: "thread.turn.start",
          commandId: yield* commandId("thread-create-turn-start"),
          threadId: nextThreadId,
          message: {
            messageId: yield* messageId("thread-create-message"),
            role: "user",
            text: input.prompt,
            attachments: [],
          },
          ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
          runtimeMode: input.runtimeMode ?? "full-access",
          interactionMode: input.interactionMode ?? "default",
          createdAt,
        })
        .pipe(
          Effect.mapError(
            toThreadOrchestrationError("create_thread.turn_start", {
              threadId: nextThreadId,
              projectId: project.id,
            }),
          ),
        );

      yield* appendRelationship({
        scope,
        kind: "createdBy",
        targetThreadId: nextThreadId,
        summary: `Created by thread ${scope.threadId}.`,
        createdAt,
      });

      return {
        thread: {
          threadId: nextThreadId,
          projectId: project.id,
          title,
          projectTitle: project.title,
          status: "running",
          modelSelection: selectedModel,
          runtimeMode: input.runtimeMode ?? "full-access",
          interactionMode: input.interactionMode ?? "default",
          workspaceRoot: project.workspaceRoot,
          worktreePath: prepared?.compatibilityWorktreePath ?? null,
          createdAt,
          updatedAt: createdAt,
        },
        promptSubmitted: true,
      };
    });

  const forkThread = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationForkThreadInput,
  ) =>
    Effect.gen(function* () {
      const sourceThreadId = input.threadId ?? scope.threadId;
      const model = yield* snapshot;
      const sourceThread = findThread(model.threads, sourceThreadId);
      if (!sourceThread) {
        return yield* new ThreadOrchestrationError({
          operation: "fork_thread",
          message: `Thread '${sourceThreadId}' was not found.`,
          threadId: sourceThreadId,
        });
      }
      const project = findProject(model.projects, sourceThread.projectId);
      if (!project) {
        return yield* new ThreadOrchestrationError({
          operation: "fork_thread",
          message: `Project '${sourceThread.projectId}' for thread '${sourceThreadId}' was not found.`,
          threadId: sourceThreadId,
          projectId: sourceThread.projectId,
        });
      }
      const createdAt = yield* nowIso;
      const nextThreadId = yield* threadId("fork");
      const title = `Fork of ${sourceThread.title}`;
      const prepared =
        input.environment?.type === "worktree"
          ? yield* workspaceService
              .prepareWorkspace({
                threadId: nextThreadId,
                kind: "auto",
                roots: [
                  {
                    projectId: project.id,
                    sourcePath: project.workspaceRoot,
                    role: "primary",
                  },
                ],
                displayNameSeed: title,
                retentionPolicy: "explicit-delete",
              })
              .pipe(
                Effect.mapError(
                  toThreadOrchestrationError("fork_thread.prepare_workspace", {
                    threadId: nextThreadId,
                    projectId: project.id,
                  }),
                ),
              )
          : undefined;

      yield* engine
        .dispatch({
          type: "thread.create",
          commandId: yield* commandId("thread-fork-create"),
          threadId: nextThreadId,
          projectId: project.id,
          title,
          modelSelection: sourceThread.modelSelection,
          runtimeMode: sourceThread.runtimeMode,
          interactionMode: sourceThread.interactionMode,
          branch: prepared?.compatibilityBranch ?? null,
          worktreePath: prepared?.compatibilityWorktreePath ?? sourceThread.worktreePath,
          workspaceId: prepared?.workspace.id ?? null,
          createdAt,
        })
        .pipe(
          Effect.mapError(
            toThreadOrchestrationError("fork_thread.dispatch", {
              threadId: nextThreadId,
              projectId: project.id,
            }),
          ),
        );
      yield* appendRelationship({
        scope,
        kind: "forkedFrom",
        targetThreadId: nextThreadId,
        summary: `Forked from thread ${sourceThreadId} by thread ${scope.threadId}.`,
        createdAt,
      });
      return {
        thread: {
          threadId: nextThreadId,
          projectId: project.id,
          title,
          projectTitle: project.title,
          status: "idle",
          modelSelection: sourceThread.modelSelection,
          runtimeMode: sourceThread.runtimeMode,
          interactionMode: sourceThread.interactionMode,
          workspaceRoot: project.workspaceRoot,
          worktreePath: prepared?.compatibilityWorktreePath ?? sourceThread.worktreePath,
          createdAt,
          updatedAt: createdAt,
        },
        transcriptCloned: false,
      };
    });

  const sendMessageToThread = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationSendMessageInput,
  ) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      yield* engine
        .dispatch({
          type: "thread.message.queue",
          commandId: yield* commandId("thread-message-queue"),
          threadId: input.threadId,
          message: {
            messageId: yield* messageId("thread-message"),
            role: "user",
            text: input.prompt,
            attachments: [],
          },
          ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
          runtimeMode: input.runtimeMode ?? "full-access",
          interactionMode: input.interactionMode ?? "default",
          createdAt,
        })
        .pipe(
          Effect.mapError(
            toThreadOrchestrationError("send_message_to_thread.dispatch", {
              threadId: input.threadId,
            }),
          ),
        );
      if (input.threadId !== scope.threadId) {
        yield* appendRelationship({
          scope,
          kind: "messagedBy",
          targetThreadId: input.threadId,
          summary: `Messaged by thread ${scope.threadId}.`,
          createdAt,
        });
      }
      const thread = yield* resolveThreadSummary(input.threadId);
      return { thread, queued: true };
    });

  const setThreadTitle = (
    scope: McpInvocationContext.McpInvocationScope,
    input: ThreadOrchestrationSetThreadTitleInput,
  ) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      yield* engine
        .dispatch({
          type: "thread.meta.update",
          commandId: yield* commandId("thread-title"),
          threadId: input.threadId,
          title: input.title,
        })
        .pipe(
          Effect.mapError(
            toThreadOrchestrationError("set_thread_title.dispatch", {
              threadId: input.threadId,
            }),
          ),
        );
      if (input.threadId !== scope.threadId) {
        yield* appendRelationship({
          scope,
          kind: "renamedBy",
          targetThreadId: input.threadId,
          summary: `Renamed by thread ${scope.threadId}.`,
          createdAt,
        });
      }
      const summary = yield* resolveThreadSummary(input.threadId);
      return { ...summary, title: input.title, updatedAt: createdAt };
    });

  return ThreadOrchestrationService.of({
    listProjects,
    listThreads,
    readThread,
    createThread,
    forkThread,
    sendMessageToThread,
    setThreadTitle,
  });
});

export const layer = Layer.effect(ThreadOrchestrationService, make);
