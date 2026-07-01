import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  ThreadOrchestrationError,
  ThreadWorkspaceId,
  ThreadWorkspaceRootId,
  type OrchestrationCommand,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationCommandInvariantError } from "../../../orchestration/Errors.ts";
import * as ThreadWorkspaceService from "../../../workspace/ThreadWorkspaceService.ts";
import type * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CodexThreadForkImporter } from "./CodexThreadForkImporter.ts";
import { ThreadOrchestrationService, layer as ThreadOrchestrationServiceLive } from "./service.ts";

const actorThreadId = ThreadId.make("thread-actor");
const targetThreadId = ThreadId.make("thread-target");
const projectId = "project-1" as OrchestrationProject["id"];
const workspaceId = ThreadWorkspaceId.make("workspace-fork");
const workspaceRootId = ThreadWorkspaceRootId.make("workspace-root-fork");

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: actorThreadId,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["threads"]),
  issuedAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
};

const project: OrchestrationProject = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo/project",
  defaultModelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  },
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
};

const makeThread = (id: typeof targetThreadId): OrchestrationThread => ({
  id,
  projectId,
  title: id === actorThreadId ? "Actor" : "Target",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  workspaceId: null,
  latestTurn: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
  messages: [],
  queuedMessages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
});

const readModel: OrchestrationReadModel = {
  snapshotSequence: 1,
  projects: [project],
  threads: [makeThread(actorThreadId), makeThread(targetThreadId)],
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const unsupportedCodexForkImporterLayer = Layer.succeed(CodexThreadForkImporter, {
  fork: (input) =>
    Effect.fail(
      new ThreadOrchestrationError({
        operation: "fork_thread.codex",
        code: "unsupported_source",
        message: `Thread '${input.sourceThread.id}' is not backed by Codex.`,
        threadId: input.sourceThread.id,
      }),
    ),
});

it.effect("queues cross-thread messages and records relationship activities", () => {
  const dispatched: OrchestrationCommand[] = [];
  const testLayer = ThreadOrchestrationServiceLive.pipe(
    Layer.provide(unsupportedCodexForkImporterLayer),
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed(readModel),
        getSnapshot: () => Effect.succeed(readModel),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
        getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 2 }),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.succeed(Option.none()),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.succeed(Option.none()),
        getThreadDetailById: () => Effect.succeed(Option.none()),
      }),
    ),
    Layer.provide(
      Layer.succeed(ThreadWorkspaceService.ThreadWorkspaceService, {
        prepareWorkspace: () => Effect.die("unused"),
        resolvePrimaryCwd: () => Effect.succeed(undefined as string | undefined),
        deleteWorkspace: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadOrchestrationService;
    const result = yield* service.sendMessageToThread(scope, {
      threadId: targetThreadId,
      prompt: "Please review the plan.",
    });

    expect(result.thread.threadId).toBe(targetThreadId);
    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.message.queue",
      "thread.activity.append",
    ]);
    expect(dispatched[0]).toMatchObject({
      type: "thread.message.queue",
      threadId: targetThreadId,
      message: { text: "Please review the plan." },
    });
    expect(dispatched[1]).toMatchObject({
      type: "thread.activity.append",
      threadId: targetThreadId,
      activity: {
        kind: "thread-orchestration.relationship",
        payload: {
          kind: "messagedBy",
          actorThreadId,
          targetThreadId,
        },
      },
    });
    expect((dispatched[0] as { commandId: CommandId }).commandId).not.toBe(
      (dispatched[1] as { commandId: CommandId }).commandId,
    );
  }).pipe(Effect.provide(testLayer));
});

it.effect("creates threads before starting their initial turn", () => {
  const dispatched: OrchestrationCommand[] = [];
  const testLayer = ThreadOrchestrationServiceLive.pipe(
    Layer.provide(unsupportedCodexForkImporterLayer),
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed(readModel),
        getSnapshot: () => Effect.succeed(readModel),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
        getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 2 }),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.succeed(Option.none()),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.succeed(Option.none()),
        getThreadDetailById: () => Effect.succeed(Option.none()),
      }),
    ),
    Layer.provide(
      Layer.succeed(ThreadWorkspaceService.ThreadWorkspaceService, {
        prepareWorkspace: () => Effect.die("unused"),
        resolvePrimaryCwd: () => Effect.succeed(undefined as string | undefined),
        deleteWorkspace: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadOrchestrationService;
    const result = yield* service.createThread(scope, {
      prompt: "Please review the implementation.",
      title: "Reviewer",
      target: {
        type: "project",
        projectId,
        environment: { type: "local" },
      },
    });

    expect(result.promptSubmitted).toBe(true);
    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.turn.start",
      "thread.activity.append",
    ]);
    expect(dispatched[0]).toMatchObject({
      type: "thread.create",
      threadId: result.thread.threadId,
      projectId,
      title: "Reviewer",
      modelSelection: project.defaultModelSelection,
    });
    expect(dispatched[1]).toMatchObject({
      type: "thread.turn.start",
      threadId: result.thread.threadId,
      message: { text: "Please review the implementation." },
    });
    expect(dispatched[1]).not.toHaveProperty("bootstrap");
    expect(dispatched[2]).toMatchObject({
      type: "thread.activity.append",
      threadId: result.thread.threadId,
      activity: {
        kind: "thread-orchestration.relationship",
        payload: {
          kind: "createdBy",
          actorThreadId,
          targetThreadId: result.thread.threadId,
        },
      },
    });
  }).pipe(Effect.provide(testLayer));
});

it.effect("prepares requested worktrees for forked threads", () => {
  const dispatched: OrchestrationCommand[] = [];
  const preparedInputs: Parameters<
    ThreadWorkspaceService.ThreadWorkspaceService["Service"]["prepareWorkspace"]
  >[0][] = [];
  const testLayer = ThreadOrchestrationServiceLive.pipe(
    Layer.provide(unsupportedCodexForkImporterLayer),
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed(readModel),
        getSnapshot: () => Effect.succeed(readModel),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
        getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 2 }),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.succeed(Option.none()),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.succeed(Option.none()),
        getThreadDetailById: () => Effect.succeed(Option.none()),
      }),
    ),
    Layer.provide(
      Layer.succeed(ThreadWorkspaceService.ThreadWorkspaceService, {
        prepareWorkspace: (input) =>
          Effect.sync(() => {
            preparedInputs.push(input);
            return {
              workspace: {
                id: workspaceId,
                kind: "jj-workspace",
                lifecycle: "active",
                displayName: "Fork of Target",
                managed: true,
                primaryRootId: workspaceRootId,
                roots: [],
                createdForThreadId: input.threadId,
                retentionPolicy: "explicit-delete",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                deletedAt: null,
                failureDetail: null,
                metadata: {},
              },
              primaryCwd: "/repo/project-worktree",
              compatibilityWorktreePath: "/repo/project-worktree",
              compatibilityBranch: "feature/fork",
            };
          }),
        resolvePrimaryCwd: () => Effect.succeed(undefined as string | undefined),
        deleteWorkspace: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadOrchestrationService;
    const result = yield* service.forkThread(scope, {
      threadId: targetThreadId,
      environment: { type: "worktree" },
    });

    expect(preparedInputs).toMatchObject([
      {
        kind: "auto",
        roots: [{ projectId, sourcePath: "/repo/project", role: "primary" }],
        displayNameSeed: "Fork of Target",
        retentionPolicy: "explicit-delete",
      },
    ]);
    expect(result.thread.worktreePath).toBe("/repo/project-worktree");
    expect(result.transcriptCloned).toBe(false);
    expect(dispatched.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.activity.append",
    ]);
    expect(dispatched[0]).toMatchObject({
      type: "thread.create",
      projectId,
      title: "Fork of Target",
      branch: "feature/fork",
      worktreePath: "/repo/project-worktree",
      workspaceId,
    });
    expect(dispatched[1]).toMatchObject({
      type: "thread.activity.append",
      threadId: result.thread.threadId,
      activity: {
        kind: "thread-orchestration.relationship",
        payload: {
          kind: "forkedFrom",
          actorThreadId,
          targetThreadId: result.thread.threadId,
        },
      },
    });
  }).pipe(Effect.provide(testLayer));
});

it.effect("cleans up prepared workspaces when fallback fork dispatch fails", () => {
  const deletedWorkspaceIds: ThreadWorkspaceId[] = [];
  const testLayer = ThreadOrchestrationServiceLive.pipe(
    Layer.provide(unsupportedCodexForkImporterLayer),
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: () =>
          Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: "thread.create",
              detail: "Dispatch failed.",
            }),
          ),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed(readModel),
        getSnapshot: () => Effect.succeed(readModel),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
        getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 2 }),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.succeed(Option.none()),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.succeed(Option.none()),
        getThreadDetailById: () => Effect.succeed(Option.none()),
      }),
    ),
    Layer.provide(
      Layer.succeed(ThreadWorkspaceService.ThreadWorkspaceService, {
        prepareWorkspace: (input) =>
          Effect.succeed({
            workspace: {
              id: workspaceId,
              kind: "jj-workspace",
              lifecycle: "active",
              displayName: "Fork of Target",
              managed: true,
              primaryRootId: workspaceRootId,
              roots: [],
              createdForThreadId: input.threadId,
              retentionPolicy: "explicit-delete",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              deletedAt: null,
              failureDetail: null,
              metadata: {},
            },
            primaryCwd: "/repo/project-worktree",
            compatibilityWorktreePath: "/repo/project-worktree",
            compatibilityBranch: "feature/fork",
          }),
        resolvePrimaryCwd: () => Effect.succeed(undefined as string | undefined),
        deleteWorkspace: (input) =>
          Effect.sync(() => {
            deletedWorkspaceIds.push(input.workspaceId);
          }),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadOrchestrationService;
    const error = yield* service
      .forkThread(scope, {
        threadId: targetThreadId,
        environment: { type: "worktree" },
      })
      .pipe(Effect.flip);

    expect(error).toMatchObject({ operation: "fork_thread.dispatch" });
    expect(deletedWorkspaceIds).toEqual([workspaceId]);
  }).pipe(Effect.provide(testLayer));
});

it.effect("uses Codex App Server fork imports for Codex-backed threads", () => {
  const dispatched: OrchestrationCommand[] = [];
  const importerInputs: Parameters<CodexThreadForkImporter["Service"]["fork"]>[0][] = [];
  const codexForkImporterLayer = Layer.succeed(CodexThreadForkImporter, {
    fork: (input) =>
      Effect.sync(() => {
        importerInputs.push(input);
        return {
          thread: {
            threadId: input.threadId,
            projectId: input.project.id,
            title: input.title,
            projectTitle: input.project.title,
            status: "idle" as const,
            modelSelection: input.sourceThread.modelSelection,
            runtimeMode: input.sourceThread.runtimeMode,
            interactionMode: input.sourceThread.interactionMode,
            workspaceRoot: input.project.workspaceRoot,
            worktreePath: input.sourceThread.worktreePath,
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
          },
          sourceProviderThreadId: "provider-source-thread",
          providerThreadId: "provider-fork-thread",
          importedMessageCount: 2,
        };
      }),
  });
  const testLayer = ThreadOrchestrationServiceLive.pipe(
    Layer.provide(codexForkImporterLayer),
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed(readModel),
        getSnapshot: () => Effect.succeed(readModel),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
        getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 2 }),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.succeed(Option.none()),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.succeed(Option.none()),
        getThreadDetailById: () => Effect.succeed(Option.none()),
      }),
    ),
    Layer.provide(
      Layer.succeed(ThreadWorkspaceService.ThreadWorkspaceService, {
        prepareWorkspace: () => Effect.die("unused"),
        resolvePrimaryCwd: () => Effect.succeed(undefined as string | undefined),
        deleteWorkspace: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadOrchestrationService;
    const result = yield* service.forkThread(scope, { threadId: targetThreadId });

    expect(importerInputs).toMatchObject([
      {
        sourceThread: { id: targetThreadId },
        project: { id: projectId },
        title: "Fork of Target",
      },
    ]);
    expect(result.transcriptCloned).toBe(true);
    expect(dispatched.map((command) => command.type)).toEqual(["thread.activity.append"]);
    expect(dispatched[0]).toMatchObject({
      type: "thread.activity.append",
      threadId: result.thread.threadId,
      activity: {
        kind: "thread-orchestration.relationship",
        payload: {
          kind: "forkedFrom",
          actorThreadId,
          targetThreadId: result.thread.threadId,
        },
      },
    });
  }).pipe(Effect.provide(testLayer));
});

it.effect("cleans up prepared workspaces when Codex-backed forks fail", () => {
  const dispatched: OrchestrationCommand[] = [];
  const deletedWorkspaceIds: ThreadWorkspaceId[] = [];
  const codexForkImporterLayer = Layer.succeed(CodexThreadForkImporter, {
    fork: () =>
      Effect.fail(
        new ThreadOrchestrationError({
          operation: "fork_thread.codex_fork",
          code: "operation_failed",
          message: "Codex App Server fork failed.",
          threadId: targetThreadId,
          projectId,
        }),
      ),
  });
  const testLayer = ThreadOrchestrationServiceLive.pipe(
    Layer.provide(codexForkImporterLayer),
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed(readModel),
        getSnapshot: () => Effect.succeed(readModel),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
        getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 2 }),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.succeed(Option.none()),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.succeed(Option.none()),
        getThreadDetailById: () => Effect.succeed(Option.none()),
      }),
    ),
    Layer.provide(
      Layer.succeed(ThreadWorkspaceService.ThreadWorkspaceService, {
        prepareWorkspace: (input) =>
          Effect.succeed({
            workspace: {
              id: workspaceId,
              kind: "jj-workspace",
              lifecycle: "active",
              displayName: "Fork of Target",
              managed: true,
              primaryRootId: workspaceRootId,
              roots: [],
              createdForThreadId: input.threadId,
              retentionPolicy: "explicit-delete",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              deletedAt: null,
              failureDetail: null,
              metadata: {},
            },
            primaryCwd: "/repo/project-worktree",
            compatibilityWorktreePath: "/repo/project-worktree",
            compatibilityBranch: "feature/fork",
          }),
        resolvePrimaryCwd: () => Effect.succeed(undefined as string | undefined),
        deleteWorkspace: (input) =>
          Effect.sync(() => {
            deletedWorkspaceIds.push(input.workspaceId);
          }),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadOrchestrationService;
    const error = yield* service
      .forkThread(scope, {
        threadId: targetThreadId,
        environment: { type: "worktree" },
      })
      .pipe(Effect.flip);

    expect(error).toMatchObject({ operation: "fork_thread.codex_fork" });
    expect(deletedWorkspaceIds).toEqual([workspaceId]);
    expect(dispatched).toEqual([]);
  }).pipe(Effect.provide(testLayer));
});

it.effect("reads compact thread results without recording read relationships", () => {
  const dispatched: OrchestrationCommand[] = [];
  const assistantMessage = {
    id: "message-assistant" as OrchestrationThread["messages"][number]["id"],
    role: "assistant" as const,
    text: "The review is complete.",
    turnId: null,
    streaming: false,
    createdAt: "2026-01-01T00:01:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
  };
  const model: OrchestrationReadModel = {
    ...readModel,
    threads: [
      makeThread(actorThreadId),
      {
        ...makeThread(targetThreadId),
        messages: [
          {
            id: "message-user" as OrchestrationThread["messages"][number]["id"],
            role: "user",
            text: "Please review.",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          assistantMessage,
        ],
      },
    ],
  };
  const testLayer = ThreadOrchestrationServiceLive.pipe(
    Layer.provide(unsupportedCodexForkImporterLayer),
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed(model),
        getSnapshot: () => Effect.succeed(model),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
        getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 2 }),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.succeed(Option.none()),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.succeed(Option.none()),
        getThreadDetailById: () => Effect.succeed(Option.none()),
      }),
    ),
    Layer.provide(
      Layer.succeed(ThreadWorkspaceService.ThreadWorkspaceService, {
        prepareWorkspace: () => Effect.die("unused"),
        resolvePrimaryCwd: () => Effect.succeed(undefined as string | undefined),
        deleteWorkspace: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadOrchestrationService;
    const result = yield* service.readThreadResult({ threadId: targetThreadId });

    expect(result.thread.threadId).toBe(targetThreadId);
    expect(result.latestAssistantMessage).toEqual(assistantMessage);
    expect(result.queuedMessageCount).toBe(0);
    expect(dispatched).toEqual([]);
  }).pipe(Effect.provide(testLayer));
});

it.effect("awaits idle threads without polling side effects", () => {
  const dispatched: OrchestrationCommand[] = [];
  const testLayer = ThreadOrchestrationServiceLive.pipe(
    Layer.provide(unsupportedCodexForkImporterLayer),
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed(readModel),
        getSnapshot: () => Effect.succeed(readModel),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
        getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 2 }),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.succeed(Option.none()),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.succeed(Option.none()),
        getThreadDetailById: () => Effect.succeed(Option.none()),
      }),
    ),
    Layer.provide(
      Layer.succeed(ThreadWorkspaceService.ThreadWorkspaceService, {
        prepareWorkspace: () => Effect.die("unused"),
        resolvePrimaryCwd: () => Effect.succeed(undefined as string | undefined),
        deleteWorkspace: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadOrchestrationService;
    const result = yield* service.awaitThread({
      threadId: targetThreadId,
      until: "idle",
      timeoutMs: 100,
      pollIntervalMs: 100,
    });

    expect(result.satisfied).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.result.thread.threadId).toBe(targetThreadId);
    expect(dispatched).toEqual([]);
  }).pipe(Effect.provide(testLayer));
});

it.effect("reads relationship graphs without adding read edges", () => {
  const dispatched: OrchestrationCommand[] = [];
  const createdAt = "2026-01-01T00:02:00.000Z";
  const model: OrchestrationReadModel = {
    ...readModel,
    threads: [
      makeThread(actorThreadId),
      {
        ...makeThread(targetThreadId),
        activities: [
          {
            id: "activity-message" as OrchestrationThread["activities"][number]["id"],
            tone: "tool",
            kind: "thread-orchestration.relationship",
            summary: "Messaged by actor.",
            payload: {
              kind: "messagedBy",
              actorThreadId,
              targetThreadId,
              createdAt,
            },
            turnId: null,
            createdAt,
          },
          {
            id: "activity-read" as OrchestrationThread["activities"][number]["id"],
            tone: "tool",
            kind: "thread-orchestration.relationship",
            summary: "Read by actor.",
            payload: {
              kind: "readBy",
              actorThreadId,
              targetThreadId,
              createdAt,
            },
            turnId: null,
            createdAt,
          },
        ],
      },
    ],
  };
  const testLayer = ThreadOrchestrationServiceLive.pipe(
    Layer.provide(unsupportedCodexForkImporterLayer),
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.succeed(ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed(model),
        getSnapshot: () => Effect.succeed(model),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
        getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 2 }),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.succeed(Option.none()),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.succeed(Option.none()),
        getThreadDetailById: () => Effect.succeed(Option.none()),
      }),
    ),
    Layer.provide(
      Layer.succeed(ThreadWorkspaceService.ThreadWorkspaceService, {
        prepareWorkspace: () => Effect.die("unused"),
        resolvePrimaryCwd: () => Effect.succeed(undefined as string | undefined),
        deleteWorkspace: () => Effect.die("unused"),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadOrchestrationService;
    const graph = yield* service.getThreadGraph({
      rootThreadId: actorThreadId,
      depth: 1,
    });

    expect(graph.nodes.map((node) => node.threadId).toSorted()).toEqual(
      [actorThreadId, targetThreadId].toSorted(),
    );
    expect(graph.edges).toEqual([
      {
        kind: "messagedBy",
        actorThreadId,
        targetThreadId,
        createdAt,
      },
    ]);
    expect(dispatched).toEqual([]);
  }).pipe(Effect.provide(testLayer));
});
