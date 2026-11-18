import {
  ModelSelection,
  type ScheduledTask,
  ScheduledTaskError,
  type ScheduledTaskUpsertInput,
  ScheduledTaskUpsertSchedule,
  TrimmedNonEmptyString,
  scheduledTaskThreadMode,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import { isSameSchedule } from "./Schedule.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

/** Written by the host's configuration (the maintainer's `~/infra`) into T3's state directory. */
export const DECLARED_SCHEDULED_TASKS_FILE = "declared-scheduled-tasks.json";
const REAPPLY_AFTER_MS = 5 * 60 * 1_000;

const Declaration = Schema.Struct({
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  schedule: ScheduledTaskUpsertSchedule.pipe(
    Schema.refine(
      (schedule): schedule is Extract<typeof schedule, { type: "fixed_time" | "interval" }> =>
        schedule.type === "fixed_time" || schedule.type === "interval",
      { expected: "a time of day or an interval" },
    ),
  ),
  /** A project's absolute path; without one the task runs in No project. */
  project: Schema.optional(TrimmedNonEmptyString),
  /** Default: the project's default model when the task is applied. */
  model: Schema.optional(ModelSelection),
});
type Declaration = typeof Declaration.Type;

const DeclarationsFile = Schema.fromJsonString(
  Schema.Struct({
    tasks: Schema.Record(
      TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/)),
      Declaration,
    ),
  }),
);
const decodeDeclarations = Schema.decodeUnknownEffect(DeclarationsFile);
const sameModelSelection = Schema.toEquivalence(ModelSelection);

type DesiredTask = ScheduledTaskUpsertInput & { readonly schedule: Declaration["schedule"] };

function matches(task: ScheduledTask, desired: DesiredTask): boolean {
  return (
    task.title === desired.title &&
    task.prompt === desired.prompt &&
    isSameSchedule(task.schedule, desired.schedule) &&
    task.projectId === desired.projectId &&
    sameModelSelection(task.modelSelection, desired.modelSelection) &&
    task.runtimeMode === desired.runtimeMode &&
    task.interactionMode === desired.interactionMode &&
    task.workspaceStrategy.type === "root" &&
    scheduledTaskThreadMode(task) === "new_thread"
  );
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tasks = yield* ScheduledTaskService.ScheduledTaskService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const projects = yield* ProjectService.ProjectService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const scheduler = yield* Scheduler.Scheduler;
  const file = path.join(config.stateDir, DECLARED_SCHEDULED_TASKS_FILE);

  const fail = (key: string, message: string, cause?: unknown) =>
    new ScheduledTaskError({
      message,
      taskId: ScheduledTaskService.declaredScheduledTaskId(key),
      ...(cause === undefined ? {} : { cause }),
    });

  const desiredTask = Effect.fn("DeclaredScheduledTasks.desiredTask")(function* (
    key: string,
    declaration: Declaration,
    enabled: boolean,
  ) {
    const projectId =
      declaration.project === undefined
        ? (yield* folders.ensureScratchProject.pipe(
            Effect.mapError((cause) => fail(key, "No project is unavailable here.", cause)),
          )).projectId
        : yield* projects.getByWorkspaceRoot(declaration.project).pipe(
            Effect.mapError((cause) => fail(key, "Could not look up its project.", cause)),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(fail(key, `No project here has the path ${declaration.project}.`)),
                onSome: (project) => Effect.succeed(project.id),
              }),
            ),
          );
    const project = yield* projects.getById(projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError((cause) => fail(key, "Could not look up its project.", cause)),
    );
    const resolved = resolveProjectSettings(
      yield* settings.getSettings.pipe(
        Effect.mapError((cause) => fail(key, "Could not read the settings.", cause)),
      ),
      projectId,
      project,
    ).settings;
    const modelSelection = declaration.model ?? resolved.defaultModelSelection;
    if (modelSelection === null) {
      return yield* fail(key, "It names no model and its project has no default model.");
    }
    return {
      id: ScheduledTaskService.declaredScheduledTaskId(key),
      title: declaration.title,
      prompt: declaration.prompt,
      enabled,
      schedule: declaration.schedule,
      projectId,
      threadId: null,
      threadMode: "new_thread",
      workspaceStrategy: { type: "root" },
      modelSelection,
      runtimeMode: resolved.defaultRuntimeMode,
      interactionMode: "default",
      createdBy: "system",
      creationSource: "server",
    } satisfies DesiredTask;
  });

  /** Brings the declared tasks in line with the file; a task that cannot apply logs an error. */
  const reconcile = Effect.fn("DeclaredScheduledTasks.reconcile")(function* (
    declarations: Readonly<Record<string, Declaration>>,
  ) {
    const stored = new Map(
      (yield* tasks.list()).tasks
        .filter((task) => task.declared === true)
        .map((task) => [task.id, task]),
    );
    for (const [key, declaration] of Object.entries(declarations)) {
      const id = ScheduledTaskService.declaredScheduledTaskId(key);
      const existing = stored.get(id);
      stored.delete(id);
      // The host owns the definition; pausing stays with the user.
      const applied = yield* desiredTask(key, declaration, existing?.enabled ?? true).pipe(
        Effect.flatMap((desired) =>
          existing !== undefined && matches(existing, desired)
            ? Effect.void
            : tasks.upsert(desired, { declared: true }),
        ),
        Effect.result,
      );
      if (Result.isFailure(applied)) {
        yield* Effect.logError("A declared scheduled task was not applied", {
          key,
          message: applied.failure.message,
        });
      }
    }
    for (const task of stored.values()) {
      const removed = yield* Effect.result(tasks.delete({ id: task.id }, { declared: true }));
      if (Result.isFailure(removed)) {
        yield* Effect.logError("A scheduled task no longer declared was not removed", {
          taskId: task.id,
          message: removed.failure.message,
        });
      }
    }
  });

  // Applying again every few minutes also picks up a new default model and a task that failed.
  const lastAttempt = yield* Ref.make<{
    readonly content: string | null;
    readonly at: number;
  } | null>(null);
  const tick = Effect.gen(function* () {
    const read = yield* fs.readFileString(file).pipe(
      // A host that declares nothing has no file.
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed('{"tasks":{}}'),
      ),
      Effect.result,
    );
    const content = Result.isSuccess(read) ? read.success : null;
    const now = yield* Clock.currentTimeMillis;
    const last = yield* Ref.get(lastAttempt);
    if (last !== null && last.content === content && now < last.at + REAPPLY_AFTER_MS) return;
    yield* Ref.set(lastAttempt, { content, at: now });
    if (Result.isFailure(read)) {
      return yield* Effect.logError("Could not read the declared scheduled tasks", {
        file,
        message: read.failure.message,
      });
    }
    const declarations = yield* Effect.result(decodeDeclarations(read.success));
    if (Result.isFailure(declarations)) {
      return yield* Effect.logError("The declared scheduled tasks are invalid; nothing changed", {
        file,
        message: declarations.failure.message,
      });
    }
    yield* reconcile(declarations.success.tasks).pipe(
      Effect.catch((error) =>
        Effect.logError("Could not apply the declared scheduled tasks", {
          message: error.message,
        }),
      ),
    );
  });
  yield* scheduler.register("declared-scheduled-tasks", tick);
});

/** Keeps the scheduled tasks the host's configuration declares in line with its file. */
export const layer = Layer.effectDiscard(make);
