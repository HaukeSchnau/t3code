import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import { ServerConfig } from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DeclaredScheduledTasks from "./DeclaredScheduledTasks.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const scratch = ProjectId.make("project:scratch");
const repo = ProjectId.make("project:repo");
const defaultModel = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
};

const declaration = (prompt: string, extra: Record<string, unknown> = {}) => ({
  title: "Nightly pass",
  prompt,
  schedule: { type: "fixed_time", timeOfDay: "03:30" },
  ...extra,
});

/** Runs a test against the real task service, with the scheduler's sources run by hand. */
const withDeclarations = <A, E>(
  test: (input: {
    readonly tick: Effect.Effect<void>;
    readonly write: (contents: unknown) => Effect.Effect<void>;
    readonly remove: Effect.Effect<void>;
    readonly declared: Effect.Effect<ReadonlyArray<ScheduledTask>>;
    /** Errors logged so far; `clear` empties the list. */
    readonly errors: { readonly logged: () => ReadonlyArray<string>; readonly clear: () => void };
  }) => Effect.Effect<A, E, ScheduledTaskService.ScheduledTaskService>,
) =>
  Effect.gen(function* () {
    const sources = yield* Ref.make(new Map<string, Effect.Effect<void>>());
    const logged: string[] = [];
    const scheduler = Layer.succeed(Scheduler.Scheduler, {
      register: <E2, R>(name: string, work: Effect.Effect<void, E2, R>) =>
        Effect.gen(function* () {
          const context = yield* Effect.context<R>();
          yield* Ref.update(sources, (current) =>
            new Map(current).set(name, work.pipe(Effect.provideContext(context), Effect.orDie)),
          );
        }),
    });
    const config = ServerConfig.layerTest(process.cwd(), { prefix: "t3-declared-tasks-" });
    const tasks = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: () => Effect.succeed({ threadId: ThreadId.make("thread:run") } as never),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          NodeCrypto.layer,
        ),
      ),
    );
    const layer = DeclaredScheduledTasks.layer.pipe(
      Layer.provideMerge(tasks),
      Layer.provideMerge(
        Layer.mergeAll(
          scheduler,
          config,
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            ensureScratchProject: Effect.succeed({ projectId: scratch }),
            isScratchProject: (projectId) => Effect.succeed(projectId === scratch),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getByWorkspaceRoot: (root) =>
              Effect.succeed(
                root === "/home/user/acme" ? Option.some({ id: repo } as never) : Option.none(),
              ),
            getById: () => Effect.succeedNone,
          }),
          ServerSettings.layerTest({ defaultModelSelection: defaultModel }),
        ),
      ),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, SqlitePersistence.layerMemory)),
    );
    return yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { stateDir } = yield* ServerConfig;
      const file = path.join(stateDir, DeclaredScheduledTasks.DECLARED_SCHEDULED_TASKS_FILE);
      const tick = Ref.get(sources).pipe(
        Effect.flatMap((all) => all.get("declared-scheduled-tasks") ?? Effect.die("unregistered")),
      );
      return yield* test({
        tick,
        write: (contents) =>
          fs
            .writeFileString(
              file,
              typeof contents === "string" ? contents : JSON.stringify(contents),
            )
            .pipe(Effect.orDie),
        remove: fs.remove(file).pipe(Effect.orDie),
        declared: service.list().pipe(
          Effect.map(({ tasks }) => tasks.filter((task) => task.declared === true)),
          Effect.orDie,
        ),
        errors: { logged: () => logged, clear: () => logged.splice(0) },
      });
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provideMerge(
            Logger.layer([
              Logger.make(({ logLevel, message }) => {
                if (logLevel !== "Error") return;
                const [text, annotations] = message as ReadonlyArray<unknown>;
                logged.push(`${String(text)} ${JSON.stringify(annotations)}`);
              }),
            ]),
          ),
        ),
      ),
    );
  });

it.effect(
  "keeps declared tasks in line with the host's file as it changes, and never touches the user's",
  () =>
    withDeclarations(({ tick, write, remove, declared }) =>
      Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const { task: own } = yield* service.upsert({
          title: "Mine",
          prompt: "Check the build",
          enabled: true,
          schedule: { type: "interval", everyMs: 60_000 },
          projectId: repo,
          workspaceStrategy: { type: "root" },
          modelSelection: defaultModel,
          runtimeMode: "full-access",
          interactionMode: "default",
        });

        yield* write({
          tasks: {
            gardener: declaration("Tend the follow-ups."),
            digest: declaration("Write the digest.", {
              project: "/home/user/acme",
              schedule: { type: "interval", everyMs: 3_600_000 },
              model: { instanceId: "codex", model: "gpt-5.5" },
            }),
          },
        });
        yield* tick;
        const added = yield* declared;
        assert.deepEqual(added.map((task) => task.id).toSorted(), [
          "declared:digest",
          "declared:gardener",
        ]);
        const gardener = added.find((task) => task.id === "declared:gardener")!;
        assert.equal(gardener.projectId, scratch);
        assert.deepEqual(gardener.modelSelection, defaultModel);
        assert.isTrue(gardener.enabled);
        assert.isNotNull(gardener.nextRunAt);
        const digest = added.find((task) => task.id === "declared:digest")!;
        assert.equal(digest.projectId, repo);
        assert.equal(digest.modelSelection.model, "gpt-5.5");

        // Pausing stays with the user; the file owns the rest.
        yield* service.setEnabled({ id: gardener.id, enabled: false });
        yield* write({
          tasks: {
            gardener: declaration("Tend the follow-ups, and close what is done."),
            review: declaration("Review open pull requests."),
          },
        });
        yield* tick;
        const changed = yield* declared;
        assert.deepEqual(changed.map((task) => task.id).toSorted(), [
          "declared:gardener",
          "declared:review",
        ]);
        const updated = changed.find((task) => task.id === "declared:gardener")!;
        assert.equal(updated.prompt, "Tend the follow-ups, and close what is done.");
        assert.isFalse(updated.enabled);
        assert.equal(updated.createdAt, gardener.createdAt);

        // Run now and resume still work; changing or deleting it here does not.
        const ran = yield* service.runNow({ id: updated.id });
        assert.equal(ran.threadId, ThreadId.make("thread:run"));
        yield* service.setEnabled({ id: updated.id, enabled: true });
        const refusals = yield* Effect.all([
          Effect.flip(service.delete({ id: updated.id })),
          Effect.flip(
            service.upsert({
              id: updated.id,
              title: updated.title,
              prompt: "Something else",
              enabled: true,
              schedule: updated.schedule,
              projectId: updated.projectId,
              workspaceStrategy: updated.workspaceStrategy,
              modelSelection: updated.modelSelection,
              runtimeMode: updated.runtimeMode,
              interactionMode: updated.interactionMode,
            }),
          ),
        ]);
        for (const refusal of refusals) {
          assert.include(refusal.message, "host's configuration declares this task");
        }

        // A host that stops declaring tasks has no file.
        yield* remove;
        yield* tick;
        assert.lengthOf(yield* declared, 0);
        const remaining = (yield* service.list()).tasks;
        assert.deepEqual(
          remaining.map((task) => task.id),
          [own.id],
        );
        assert.equal(remaining[0]?.prompt, "Check the build");
      }),
    ),
);

it.effect("leaves declared tasks alone and logs an error when the file or a task is wrong", () =>
  withDeclarations(({ tick, write, declared, errors }) =>
    Effect.gen(function* () {
      yield* write({ tasks: { gardener: declaration("Tend the follow-ups.") } });
      yield* tick;
      assert.lengthOf(yield* declared, 1);

      for (const broken of [
        "{ not json",
        { tasks: { gardener: declaration("Tend.", { schedule: { type: "webhook" } }) } },
      ]) {
        errors.clear();
        yield* write(broken);
        yield* tick;
        const [task] = yield* declared;
        assert.equal(task?.prompt, "Tend the follow-ups.");
        assert.lengthOf(errors.logged(), 1);
        assert.include(errors.logged()[0], "invalid");
      }

      // One task that cannot apply keeps its stored version; the others still apply.
      errors.clear();
      yield* write({
        tasks: {
          gardener: declaration("Tend the follow-ups.", { project: "/home/user/missing" }),
          review: declaration("Review open pull requests."),
        },
      });
      yield* tick;
      const tasks = yield* declared;
      assert.deepEqual(tasks.map((task) => task.id).toSorted(), [
        "declared:gardener",
        "declared:review",
      ]);
      assert.equal(
        tasks.find((task) => task.id === ScheduledTaskId.make("declared:gardener"))?.projectId,
        scratch,
      );
      assert.lengthOf(errors.logged(), 1);
      assert.include(errors.logged()[0], "/home/user/missing");
      // A failed apply waits before it logs the same error again.
      yield* tick;
      assert.lengthOf(errors.logged(), 1);
    }),
  ),
);
