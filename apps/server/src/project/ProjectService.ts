import type { SkillPackId } from "@t3tools/contracts";
import {
  CommandId,
  ModelSelection,
  ProjectId,
  type Project,
  type ProjectIconOverride,
  type ProjectScript,
  type ProjectSnapshot,
  type ThreadEnvMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { IdAllocatorV2 } from "../orchestration-v2/IdAllocator.ts";
import { LegacyV1ThreadImporter } from "../orchestration-v2/LegacyV1ThreadImporter.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import {
  ThreadCommandExecutor,
  layer as threadCommandExecutorLayer,
} from "../orchestration-v2/ThreadCommandExecutor.ts";
import { planThreadDeletion } from "../orchestration-v2/ThreadDeletion.ts";
import * as ProjectionProjects from "../persistence/Services/ProjectionProjects.ts";
import { ProjectEnrichmentService, type ProjectEnrichment } from "./ProjectEnrichmentService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProcessRunner from "../processRunner.ts";
import { assertSeparateProjectRootUnchanged } from "./SeparateProjectRegistry.ts";

export interface ProjectCreateInput {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly createWorkspaceRootIfMissing?: boolean;
  readonly separateEnvironment?: boolean;
  readonly defaultModelSelection?: ModelSelection | null;
  readonly defaultSkillPackIds?: ReadonlyArray<SkillPackId>;
  readonly scripts?: ReadonlyArray<ProjectScript>;
}

export interface ProjectUpdateInput {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title?: string;
  readonly workspaceRoot?: string;
  readonly defaultModelSelection?: ModelSelection | null;
  readonly autoPull?: boolean;
  readonly projectIcon?: ProjectIconOverride | null;
  readonly faviconPath?: string | null;
  readonly defaultThreadEnvMode?: ThreadEnvMode | null;
  readonly defaultSkillPackIds?: ReadonlyArray<SkillPackId>;
  readonly scripts?: ReadonlyArray<ProjectScript>;
}

export interface ProjectBootstrapInput extends ProjectCreateInput {}

export interface ProjectDeleteInput {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly force?: boolean;
}

export class ProjectNotFoundError extends Schema.TaggedErrorClass<ProjectNotFoundError>()(
  "ProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project ${this.projectId} was not found.`;
  }
}

export class ProjectConflictError extends Schema.TaggedErrorClass<ProjectConflictError>()(
  "ProjectConflictError",
  {
    projectId: ProjectId,
    workspaceRoot: Schema.String,
    conflictingProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Workspace ${this.workspaceRoot} already belongs to project ${this.conflictingProjectId}.`;
  }
}

export class ProjectNotEmptyError extends Schema.TaggedErrorClass<ProjectNotEmptyError>()(
  "ProjectNotEmptyError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project ${this.projectId} is not empty.`;
  }
}

export class ProjectOperationError extends Schema.TaggedErrorClass<ProjectOperationError>()(
  "ProjectOperationError",
  {
    operation: Schema.Literals([
      "normalize-workspace",
      "prepare-separate-environment",
      "read-project",
      "list-projects",
      "list-threads",
      "delete-thread",
      "dispatch-project-command",
    ]),
    projectId: Schema.optional(ProjectId),
    workspaceRoot: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project operation '${this.operation}' failed${this.projectId === undefined ? "" : ` for ${this.projectId}`}.`;
  }
}

export type ProjectServiceError =
  | ProjectNotFoundError
  | ProjectConflictError
  | ProjectNotEmptyError
  | ProjectOperationError;

export class ProjectService extends Context.Service<
  ProjectService,
  {
    readonly create: (input: ProjectCreateInput) => Effect.Effect<Project, ProjectServiceError>;
    readonly bootstrap: (
      input: ProjectBootstrapInput,
    ) => Effect.Effect<
      { readonly project: Project; readonly created: boolean },
      ProjectServiceError
    >;
    readonly update: (input: ProjectUpdateInput) => Effect.Effect<Project, ProjectServiceError>;
    readonly delete: (input: ProjectDeleteInput) => Effect.Effect<Project, ProjectServiceError>;
    readonly getById: (
      projectId: ProjectId,
      options?: { readonly includeDeleted?: boolean },
    ) => Effect.Effect<Option.Option<Project>, ProjectOperationError>;
    readonly getByWorkspaceRoot: (
      workspaceRoot: string,
      options?: { readonly includeDeleted?: boolean },
    ) => Effect.Effect<Option.Option<Project>, ProjectOperationError>;
    readonly snapshot: Effect.Effect<ProjectSnapshot, ProjectOperationError>;
  }
>()("t3/project/ProjectService") {}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const projects = yield* ProjectionProjects.ProjectionProjectRepository;
  const projectEnrichment = yield* ProjectEnrichmentService;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const threadProjections = yield* ProjectionStoreV2;
  const threadEvents = yield* EventSinkV2;
  const idAllocator = yield* IdAllocatorV2;
  const legacyImporter = yield* LegacyV1ThreadImporter;
  const threadCommands = yield* ThreadCommandExecutor;

  const toProject = (
    row: ProjectionProjects.ProjectionProject,
    enrichment: ProjectEnrichment | null,
  ): Project => ({
    id: row.projectId,
    title: row.title,
    workspaceRoot: row.workspaceRoot,
    repositoryIdentity: enrichment?.repositoryIdentity ?? null,
    faviconPath: row.faviconPath ?? enrichment?.faviconPath ?? null,
    defaultModelSelection: row.defaultModelSelection,
    defaultThreadEnvMode: row.defaultThreadEnvMode,
    autoPull: row.autoPull,
    projectIcon: row.projectIcon,
    scripts: row.scripts,
    defaultSkillPackIds: row.defaultSkillPackIds ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  });

  const hydrateAvailable = Effect.fn("ProjectService.hydrateAvailable")(function* (
    row: ProjectionProjects.ProjectionProject,
  ) {
    const enrichment =
      row.deletedAt === null
        ? yield* projectEnrichment.getAvailable(row.workspaceRoot)
        : yield* projectEnrichment.peek(row.workspaceRoot);
    return toProject(row, enrichment);
  });

  const readRows = Effect.fn("ProjectService.readRows")(function* () {
    return yield* projects
      .listAll()
      .pipe(
        Effect.mapError(
          (cause) => new ProjectOperationError({ operation: "list-projects", cause }),
        ),
      );
  });

  const getById: ProjectService["Service"]["getById"] = Effect.fn("ProjectService.getById")(
    function* (projectId, options) {
      const row = yield* projects
        .getById({ projectId })
        .pipe(
          Effect.mapError(
            (cause) => new ProjectOperationError({ operation: "read-project", projectId, cause }),
          ),
        );
      if (Option.isNone(row) || (row.value.deletedAt !== null && !options?.includeDeleted)) {
        return Option.none();
      }
      return Option.some(yield* hydrateAvailable(row.value));
    },
  );

  const getByWorkspaceRoot: ProjectService["Service"]["getByWorkspaceRoot"] = Effect.fn(
    "ProjectService.getByWorkspaceRoot",
  )(function* (workspaceRoot, options) {
    const normalized = yield* workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectOperationError({
            operation: "normalize-workspace",
            workspaceRoot,
            cause,
          }),
      ),
    );
    const row = (yield* readRows()).find(
      (candidate) =>
        candidate.workspaceRoot === normalized &&
        (options?.includeDeleted === true || candidate.deletedAt === null),
    );
    return row === undefined ? Option.none() : Option.some(yield* hydrateAvailable(row));
  });

  const readCommitted = Effect.fn("ProjectService.readCommitted")(function* (projectId: ProjectId) {
    const row = yield* projects
      .getById({ projectId })
      .pipe(
        Effect.mapError(
          (cause) => new ProjectOperationError({ operation: "read-project", projectId, cause }),
        ),
      );
    if (Option.isNone(row)) {
      return yield* new ProjectOperationError({
        operation: "read-project",
        projectId,
        cause: "The accepted project command did not produce a project projection.",
      });
    }
    return yield* hydrateAvailable(row.value);
  });

  const invalidateEnrichment = (...workspaceRoots: ReadonlyArray<string>) =>
    projectEnrichment.invalidate(workspaceRoots);

  const dispatch = <A>(
    projectId: ProjectId,
    command: Parameters<OrchestrationEngineService["Service"]["dispatch"]>[0],
    onCommitted: Effect.Effect<A, ProjectOperationError>,
  ) =>
    engine.dispatch(command).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectOperationError({
            operation: "dispatch-project-command",
            projectId,
            cause,
          }),
      ),
      Effect.andThen(onCommitted),
    );

  const assertWorkspaceAvailable = Effect.fn("ProjectService.assertWorkspaceAvailable")(function* (
    projectId: ProjectId,
    workspaceRoot: string,
  ) {
    const conflicting = (yield* readRows()).find(
      (candidate) =>
        candidate.deletedAt === null &&
        candidate.projectId !== projectId &&
        candidate.workspaceRoot === workspaceRoot,
    );
    if (conflicting !== undefined) {
      return yield* new ProjectConflictError({
        projectId,
        workspaceRoot,
        conflictingProjectId: conflicting.projectId,
      });
    }
  });

  const prepareSeparateEnvironment = Effect.fn("ProjectService.prepareSeparateEnvironment")(
    function* (input: ProjectCreateInput, workspaceRoot: string) {
      if (input.separateEnvironment !== true) return;

      const launcher = (yield* HostProcessEnvironment).T3CODE_EXECUTION_LAUNCHER;
      if (launcher === undefined || launcher.trim().length === 0) {
        return yield* new ProjectOperationError({
          operation: "prepare-separate-environment",
          projectId: input.projectId,
          workspaceRoot,
          cause: new Error("Separate project environments require the managed execution launcher."),
        });
      }

      const result = yield* processRunner
        .run({
          command: launcher,
          args: ["create", workspaceRoot, "--project-id", input.projectId],
          timeout: Duration.seconds(30),
          timeoutBehavior: "timedOutResult",
          outputMode: "truncate",
          maxOutputBytes: 64 * 1024,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProjectOperationError({
                operation: "prepare-separate-environment",
                projectId: input.projectId,
                workspaceRoot,
                cause,
              }),
          ),
        );
      if (result.timedOut || result.code !== 0) {
        return yield* new ProjectOperationError({
          operation: "prepare-separate-environment",
          projectId: input.projectId,
          workspaceRoot,
          cause: new Error(
            result.timedOut
              ? "The managed execution launcher timed out while creating the project environment."
              : result.stderr.trim() ||
                `The managed execution launcher exited with code ${String(result.code)}.`,
          ),
        });
      }
    },
  );

  const create: ProjectService["Service"]["create"] = Effect.fn("ProjectService.create")(
    function* (input) {
      const requestedWorkspaceRoot =
        input.separateEnvironment === true
          ? workspacePaths.canonicalizeWorkspaceRoot(input.workspaceRoot)
          : input.workspaceRoot;
      if (input.separateEnvironment === true) {
        // Reserve the identity before asking infra to materialize the directory. This
        // avoids creating an environment for a project path already owned by another row.
        yield* assertWorkspaceAvailable(input.projectId, requestedWorkspaceRoot);
        yield* prepareSeparateEnvironment(input, requestedWorkspaceRoot);
      }
      const workspaceRoot = yield* workspacePaths
        .normalizeWorkspaceRoot(requestedWorkspaceRoot, {
          createIfMissing:
            input.separateEnvironment === true
              ? false
              : (input.createWorkspaceRootIfMissing ?? false),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProjectOperationError({
                operation: "normalize-workspace",
                projectId: input.projectId,
                workspaceRoot: input.workspaceRoot,
                cause,
              }),
          ),
        );
      yield* assertWorkspaceAvailable(input.projectId, workspaceRoot);
      const now = DateTime.formatIso(yield* DateTime.now);
      return yield* dispatch(
        input.projectId,
        {
          type: "project.create",
          commandId: input.commandId,
          projectId: input.projectId,
          title: input.title,
          workspaceRoot,
          defaultModelSelection: input.defaultModelSelection ?? null,
          scripts: [...(input.scripts ?? [])],
          defaultSkillPackIds: input.defaultSkillPackIds ?? [],
          createdAt: now,
        },
        invalidateEnrichment(workspaceRoot).pipe(Effect.andThen(readCommitted(input.projectId))),
      );
    },
  );

  const update: ProjectService["Service"]["update"] = Effect.fn("ProjectService.update")(
    function* (input) {
      const existing = yield* projects.getById({ projectId: input.projectId }).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectOperationError({
              operation: "read-project",
              projectId: input.projectId,
              cause,
            }),
        ),
      );
      if (Option.isNone(existing) || existing.value.deletedAt !== null) {
        return yield* new ProjectNotFoundError({ projectId: input.projectId });
      }
      if (input.workspaceRoot !== undefined) {
        const hostEnvironment = yield* HostProcessEnvironment;
        const canonicalWorkspaceRoot = workspacePaths.canonicalizeWorkspaceRoot(
          input.workspaceRoot,
        );
        yield* Effect.tryPromise({
          try: () =>
            assertSeparateProjectRootUnchanged(
              input.projectId,
              canonicalWorkspaceRoot,
              hostEnvironment.AGENT_EXEC_STATE,
            ),
          catch: (cause) =>
            new ProjectOperationError({
              operation: "prepare-separate-environment",
              projectId: input.projectId,
              workspaceRoot: input.workspaceRoot,
              cause,
            }),
        });
      }
      const workspaceRoot =
        input.workspaceRoot === undefined
          ? existing.value.workspaceRoot
          : yield* workspacePaths.normalizeWorkspaceRoot(input.workspaceRoot).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectOperationError({
                    operation: "normalize-workspace",
                    projectId: input.projectId,
                    workspaceRoot: input.workspaceRoot,
                    cause,
                  }),
              ),
            );
      yield* assertWorkspaceAvailable(input.projectId, workspaceRoot);
      return yield* dispatch(
        input.projectId,
        {
          type: "project.meta.update",
          commandId: input.commandId,
          projectId: input.projectId,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(workspaceRoot === existing.value.workspaceRoot ? {} : { workspaceRoot }),
          ...(input.defaultModelSelection === undefined
            ? {}
            : { defaultModelSelection: input.defaultModelSelection }),
          ...(input.autoPull === undefined ? {} : { autoPull: input.autoPull }),
          ...(input.projectIcon === undefined ? {} : { projectIcon: input.projectIcon }),
          ...(input.faviconPath === undefined ? {} : { faviconPath: input.faviconPath }),
          ...(input.defaultThreadEnvMode === undefined
            ? {}
            : { defaultThreadEnvMode: input.defaultThreadEnvMode }),
          ...(input.scripts === undefined ? {} : { scripts: [...input.scripts] }),
          ...(input.defaultSkillPackIds === undefined ? {} : { defaultSkillPackIds: input.defaultSkillPackIds }),
        },
        (workspaceRoot === existing.value.workspaceRoot
          ? Effect.void
          : invalidateEnrichment(existing.value.workspaceRoot, workspaceRoot)
        ).pipe(Effect.andThen(readCommitted(input.projectId))),
      );
    },
  );

  const bootstrap: ProjectService["Service"]["bootstrap"] = Effect.fn("ProjectService.bootstrap")(
    function* (input) {
      let existing: Option.Option<Project>;
      if (input.separateEnvironment === true) {
        const canonicalRoot = workspacePaths.canonicalizeWorkspaceRoot(input.workspaceRoot);
        const row = (yield* readRows()).find(
          (candidate) => candidate.deletedAt === null && candidate.workspaceRoot === canonicalRoot,
        );
        existing = row === undefined ? Option.none() : Option.some(yield* hydrateAvailable(row));
      } else {
        existing = yield* getByWorkspaceRoot(input.workspaceRoot);
      }
      if (Option.isSome(existing)) return { project: existing.value, created: false };
      return { project: yield* create(input), created: true };
    },
  );

  const deleteProject: ProjectService["Service"]["delete"] = Effect.fn("ProjectService.delete")(
    function* (input) {
      const { projectId } = input;
      const existing = yield* projects
        .getById({ projectId })
        .pipe(
          Effect.mapError(
            (cause) => new ProjectOperationError({ operation: "read-project", projectId, cause }),
          ),
        );
      if (Option.isNone(existing) || existing.value.deletedAt !== null) {
        return yield* new ProjectNotFoundError({ projectId });
      }

      const snapshot = yield* threadProjections
        .getShellSnapshot()
        .pipe(
          Effect.mapError(
            (cause) => new ProjectOperationError({ operation: "list-threads", projectId, cause }),
          ),
        );
      const projectThreads = [...snapshot.threads, ...snapshot.archivedThreads].filter(
        (thread) => thread.projectId === projectId,
      );
      if (projectThreads.length > 0 && input.force !== true) {
        return yield* new ProjectNotEmptyError({ projectId });
      }

      // Delete children durably before the project. Stable command IDs let a retry
      // finish a partially completed cascade without repeating cleanup effects.
      yield* Effect.forEach(
        projectThreads,
        (thread) =>
          threadCommands
            .withLock(
              thread.id,
              Effect.gen(function* () {
                yield* legacyImporter.ensureTranscript(thread.id);
                const projection = yield* threadProjections.getThreadProjection(thread.id);
                if (
                  projection.thread.deletedAt !== null ||
                  projection.thread.projectId !== projectId
                ) {
                  return;
                }
                const command = {
                  type: "thread.delete" as const,
                  commandId: CommandId.make(`${input.commandId}:delete-thread:${thread.id}`),
                  threadId: thread.id,
                };
                const now = yield* DateTime.now;
                const plan = yield* planThreadDeletion({ command, projection, now, idAllocator });
                const committed = yield* threadEvents.commitCommand({
                  commandId: command.commandId,
                  commandType: command.type,
                  threadId: command.threadId,
                  acceptedAt: now,
                  events: plan.events,
                  effects: plan.effects,
                });
                if (
                  committed.receipt.threadId !== command.threadId ||
                  committed.receipt.commandType !== command.type
                ) {
                  return yield* Effect.fail(
                    "The thread deletion command ID belongs to a different command.",
                  );
                }
                if (committed.receipt.status === "rejected") {
                  return yield* Effect.fail(
                    committed.receipt.error ?? "Thread deletion was previously rejected.",
                  );
                }
              }),
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectOperationError({ operation: "delete-thread", projectId, cause }),
              ),
            ),
        { concurrency: 1, discard: true },
      );
      return yield* dispatch(
        projectId,
        {
          type: "project.delete",
          commandId: input.commandId,
          projectId,
          ...(input.force === undefined ? {} : { force: input.force }),
        },
        invalidateEnrichment(existing.value.workspaceRoot).pipe(
          Effect.andThen(readCommitted(projectId)),
        ),
      );
    },
  );

  const snapshot = Effect.gen(function* () {
    const rows = (yield* readRows()).filter((row) => row.deletedAt === null);
    const hydrated = yield* Effect.forEach(rows, hydrateAvailable, { concurrency: 8 });
    return {
      projects: hydrated,
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    } satisfies ProjectSnapshot;
  });

  return ProjectService.of({
    create,
    bootstrap,
    update,
    delete: deleteProject,
    getById,
    getByWorkspaceRoot,
    snapshot,
  });
});

export const layer = Layer.effect(ProjectService, make).pipe(
  Layer.provide(threadCommandExecutorLayer),
  Layer.provide(ProcessRunner.layer),
);
