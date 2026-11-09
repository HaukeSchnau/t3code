import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, expect, it } from "@effect/vitest";
import {
  CommandId,
  type OrchestrationV2ServerCommand,
  type ScheduledTask,
  ScheduledTaskUpsertInput,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ServerActivation } from "../serverActivation.ts";
import { ManagedWorkspaceError } from "../workspace/WorkspaceCommand.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

it.effect("rejects a stale form save after deletion while preserving explicit-id creates", () =>
  Effect.gen(function* () {
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        id: "scheduled-task:edit-after-delete",
        title: "Review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project-stale-schedule",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const created = yield* service.upsert(input);
      const edit = yield* decodeUpsertInput({ ...input, requireExisting: true, title: "Edited" });
      expect((yield* service.upsert(edit)).task.title).toBe("Edited");
      yield* service.delete({ id: created.task.id });

      const failure = yield* service.upsert(edit).pipe(Effect.flip);
      expect(failure.message).toBe("Schedule task not found.");
      expect((yield* service.list()).tasks).toEqual([]);

      expect((yield* service.upsert(input)).task.id).toBe(created.task.id);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("preserves a due run when a save only pads the scheduled hour", () =>
  Effect.gen(function* () {
    const dueAt = DateTime.makeZonedUnsafe(
      { year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0, millisecond: 0 },
      { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
    );
    yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) - 1_000);

    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        commandId: "schedule-time-format",
        title: "Morning review",
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "fixed_time", timeOfDay: "9:00" },
        projectId: "project-schedule-time-format",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        creationSource: "mcp",
      });
      const created = yield* service.upsert(input);
      const expectedDueAt = DateTime.formatIso(DateTime.toUtc(dueAt));
      expect(created.task.nextRunAt).toBe(expectedDueAt);

      yield* TestClock.setTime(DateTime.toEpochMillis(dueAt) + 1_000);
      const update = yield* decodeUpsertInput({
        ...input,
        id: created.task.id,
        schedule: { type: "fixed_time", timeOfDay: "09:00" },
      });
      const updated = yield* service.upsert(update);
      expect(updated.task.nextRunAt).toBe(expectedDueAt);
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBe(expectedDueAt);

      const rescheduled = yield* service.upsert({
        ...update,
        schedule: { type: "fixed_time", timeOfDay: "09:30" },
      });
      expect(rescheduled.task.nextRunAt).toBe(
        DateTime.formatIso(DateTime.toUtc(DateTime.add(dueAt, { minutes: 30 }))),
      );
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("keeps the task list order when a toggle or edit rewrites updated_at", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = (id: string) => ({
        id,
        title: id,
        prompt: "Review the open pull requests.",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project-stable-order",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const listedIds = service
        .list()
        .pipe(Effect.map(({ tasks }) => tasks.map((task) => String(task.id))));

      const older = yield* service.upsert(yield* decodeUpsertInput(input("scheduled-task:older")));
      yield* TestClock.adjust("1 second");
      yield* service.upsert(yield* decodeUpsertInput(input("scheduled-task:newer")));
      const order = ["scheduled-task:newer", "scheduled-task:older"];
      expect(yield* listedIds).toEqual(order);

      yield* TestClock.adjust("1 second");
      const toggled = yield* service.setEnabled({ id: older.task.id, enabled: false });
      expect(toggled.task.updatedAt > older.task.updatedAt).toBe(true);
      expect(yield* listedIds).toEqual(order);

      yield* TestClock.adjust("1 second");
      const edit = { ...input(older.task.id), requireExisting: true, title: "Edited" };
      yield* service.upsert(yield* decodeUpsertInput({ ...edit, enabled: false }));
      expect(yield* listedIds).toEqual(order);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("runs a one-time task once, then pauses it and refuses past times", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-03T04:00:00.000Z"));
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: () => Effect.die("workspace preparation failed"),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        title: "Forwarder run check",
        prompt: "Check the 04:00Z forwarder run.",
        enabled: true,
        schedule: { type: "once", at: "2026-11-03T04:30:00Z" },
        projectId: "project-once",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const created = yield* service.upsert(input);
      expect(created.task.nextRunAt).toBe("2026-11-03T04:30:00.000Z");

      yield* TestClock.setTime(Date.parse("2026-11-03T04:31:00.000Z"));
      const ran = yield* service.runNow({ id: created.task.id });
      expect(ran.task).toMatchObject({ enabled: false, nextRunAt: null, runCount: 1 });
      expect((yield* service.list()).tasks[0]).toMatchObject({ enabled: false, nextRunAt: null });

      const pastTime = "The one-time run is in the past. Pick a future time.";
      const resumed = yield* service
        .setEnabled({ id: created.task.id, enabled: true })
        .pipe(Effect.flip);
      expect(resumed.message).toBe(pastTime);
      const recreated = yield* service.upsert({ ...input, id: created.task.id }).pipe(Effect.flip);
      expect(recreated.message).toBe(pastTime);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(
    Effect.provideService(ServerActivation, Effect.never),
    Effect.provide(SqlitePersistence.layerMemory),
  ),
);

it.effect("refuses to save a task whose runs could not get their own workspace", () =>
  Effect.gen(function* () {
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        checkWorkspaceCopy: () =>
          Effect.fail(
            new ManagedWorkspaceError({
              operation: "DirectoryCopyWorkspaces.checkSize",
              detail: "The project is 174.1 GiB, more than the 5.0 GiB a workspace copy may use.",
            }),
          ),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        title: "Daily check",
        prompt: "Check the forwarder.",
        enabled: true,
        schedule: { type: "fixed_time", timeOfDay: "07:00" },
        projectId: "project-too-big",
        workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const failure = yield* service.upsert(input).pipe(Effect.flip);
      expect(failure.message).toContain("174.1 GiB");
      expect((yield* service.list()).tasks).toEqual([]);
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

type LaunchOutcome = "setup-fails" | "setup-succeeds" | "setup-pending" | "launch-fails";
type ThreadShell = Effect.Success<
  ReturnType<ThreadManagementService.ThreadManagementService["Service"]["getThreadShell"]>
>;

const failureTrackingLayer = (input: {
  readonly outcome: Ref.Ref<LaunchOutcome>;
  readonly notices: Queue.Queue<OrchestrationV2ServerCommand>;
  readonly deletedThreads?: ReadonlyArray<string>;
  readonly pendingPreparations?: Queue.Queue<Deferred.Deferred<void, string>>;
}) =>
  ScheduledTaskService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Scheduler.layer,
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (launch) =>
            Effect.gen(function* () {
              const outcome = yield* Ref.get(input.outcome);
              if (outcome === "launch-fails") return yield* Effect.die("project is gone");
              if (outcome === "setup-pending" && input.pendingPreparations !== undefined) {
                if (launch.preparation !== undefined) {
                  yield* Queue.offer(input.pendingPreparations, launch.preparation);
                }
              } else if (launch.preparation !== undefined) {
                yield* outcome === "setup-fails"
                  ? Deferred.fail(launch.preparation, "Workspace preparation failed: disk full")
                  : Deferred.succeed(launch.preparation, undefined);
              }
              return {
                threadId: ThreadId.make("thread-run"),
              } as unknown as ThreadLaunchService.ThreadLaunchResult;
            }),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          sendToThread: () => Effect.die("thread is gone"),
          getThreadShell: (threadId) =>
            Effect.succeed({
              id: threadId,
              archivedAt: null,
              deletedAt: input.deletedThreads?.includes(threadId)
                ? "2026-11-03T04:00:00.000Z"
                : null,
            } as unknown as ThreadShell),
          dispatch: (command) =>
            Queue.offer(input.notices, command).pipe(
              Effect.as({} as Orchestrator.OrchestratorV2DispatchResult),
            ),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
      ),
    ),
  );

const settledTask = (
  service: ScheduledTaskService.ScheduledTaskService["Service"],
  expected: Partial<ScheduledTask>,
) =>
  service.subscribeList().pipe(
    Stream.map((list) => list.tasks[0]),
    Stream.filter(
      (current) =>
        current !== undefined &&
        Object.entries(expected).every(
          ([key, value]) => current[key as keyof ScheduledTask] === value,
        ),
    ),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

const failingTaskInput = (threadId: string | null) =>
  decodeUpsertInput({
    title: "Forwarder check",
    prompt: "Check the forwarder logs.",
    enabled: true,
    schedule: { type: "interval", everyMs: 3_600_000 },
    projectId: "project-forwarder",
    threadId,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
  });

it.effect("counts runs whose workspace preparation fails and pauses the task after three", () =>
  Effect.gen(function* () {
    const outcome = yield* Ref.make<LaunchOutcome>("setup-fails");
    const notices = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert(yield* failingTaskInput(null), {
        creatorThreadId: ThreadId.make("thread-creator"),
      });
      // A run counts as launched first; its preparation settles the record afterwards.
      const settled = (expected: Partial<ScheduledTask>) => settledTask(service, expected);
      const runAndSettle = (expected: Partial<ScheduledTask>) =>
        Effect.gen(function* () {
          yield* TestClock.adjust("1 minute");
          yield* service.runNow({ id: task.id });
          return yield* settled(expected);
        });

      for (const failures of [1, 2]) {
        yield* runAndSettle({ lastRunStatus: "failed", consecutiveFailures: failures });
        const notice = yield* Queue.take(notices);
        assert(notice.type === "message.dispatch");
        expect(notice.threadId).toBe("thread-creator");
        expect(notice.dispatchMode).toEqual({ type: "queue_after_active" });
        expect(notice.notification?.source).toEqual({ kind: "system" });
        expect(notice.text).toContain(task.id);
        expect(notice.text).toContain("Workspace preparation failed: disk full");
        expect(notice.text).toContain(`Failed runs in a row: ${failures}.`);
      }
      const paused = yield* runAndSettle({ consecutiveFailures: 3, enabled: false });
      expect(paused).toMatchObject({
        lastRunStatus: "failed",
        lastRunError: "Workspace preparation failed: disk full",
        nextRunAt: null,
      });
      const pausedNotice = yield* Queue.take(notices);
      assert(pausedNotice.type === "message.dispatch");
      expect(pausedNotice.text).toContain("It failed 3 times in a row, so T3 Code paused it.");

      expect((yield* service.setEnabled({ id: task.id, enabled: true })).task).toMatchObject({
        enabled: true,
        consecutiveFailures: 0,
      });
      yield* runAndSettle({ lastRunStatus: "failed", consecutiveFailures: 1 });
      yield* Queue.take(notices);
      yield* Ref.set(outcome, "setup-succeeds");
      yield* runAndSettle({ lastRunStatus: "succeeded", consecutiveFailures: 0 });
      expect(yield* Queue.size(notices)).toBe(0);
    }).pipe(Effect.provide(failureTrackingLayer({ outcome, notices })));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("counts a failed preparation that ends after the next run started", () =>
  Effect.gen(function* () {
    const outcome = yield* Ref.make<LaunchOutcome>("setup-pending");
    const notices = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
    const pendingPreparations = yield* Queue.unbounded<Deferred.Deferred<void, string>>();
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = { ...(yield* failingTaskInput(null)), commandId: CommandId.make("overlap") };
      const { task } = yield* service.upsert(input, {
        creatorThreadId: ThreadId.make("thread-creator"),
      });
      const settled = (expected: Partial<ScheduledTask>) => settledTask(service, expected);
      const launchRun = Effect.gen(function* () {
        yield* TestClock.adjust("1 minute");
        yield* service.runNow({ id: task.id });
        return yield* Queue.take(pendingPreparations);
      });
      const first = yield* launchRun;
      const second = yield* launchRun;

      yield* Deferred.fail(first, "Workspace preparation failed: disk full");
      // The second run's record stays as it is, but the first run's failure counts.
      yield* settled({ lastRunStatus: "succeeded", consecutiveFailures: 1 });
      const notice = yield* Queue.take(notices);
      assert(notice.type === "message.dispatch");
      expect(notice.text).toContain("Failed runs in a row: 1.");

      yield* Deferred.fail(second, "Workspace preparation failed: disk full");
      yield* settled({ lastRunStatus: "failed", consecutiveFailures: 2 });
      yield* Queue.take(notices);

      // A task recreated under the same id does not inherit the old task's late failure.
      const stale = yield* launchRun;
      yield* service.delete({ id: task.id });
      yield* TestClock.adjust("1 minute");
      const { task: recreated } = yield* service.upsert(input, {
        creatorThreadId: ThreadId.make("thread-creator"),
      });
      expect(recreated.id).toBe(task.id);
      const fresh = yield* launchRun;
      yield* Deferred.fail(stale, "Workspace preparation failed: disk full");
      yield* Deferred.fail(fresh, "Workspace preparation failed: disk full");
      yield* settled({ lastRunStatus: "failed", consecutiveFailures: 1 });
      const freshNotice = yield* Queue.take(notices);
      assert(freshNotice.type === "message.dispatch");
      expect(freshNotice.text).toContain("Failed runs in a row: 1.");
      expect(yield* Queue.size(notices)).toBe(0);
    }).pipe(Effect.provide(failureTrackingLayer({ outcome, notices, pendingPreparations })));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("resets the count when a successful preparation ends after the next run started", () =>
  Effect.gen(function* () {
    const outcome = yield* Ref.make<LaunchOutcome>("setup-pending");
    const notices = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
    const pendingPreparations = yield* Queue.unbounded<Deferred.Deferred<void, string>>();
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert(yield* failingTaskInput(null), {
        creatorThreadId: ThreadId.make("thread-creator"),
      });
      const settled = (expected: Partial<ScheduledTask>) => settledTask(service, expected);
      const launchRun = Effect.gen(function* () {
        yield* TestClock.adjust("1 minute");
        yield* service.runNow({ id: task.id });
        return yield* Queue.take(pendingPreparations);
      });
      yield* Deferred.fail(yield* launchRun, "Workspace preparation failed: disk full");
      yield* settled({ lastRunStatus: "failed", consecutiveFailures: 1 });
      yield* Queue.take(notices);

      const first = yield* launchRun;
      const second = yield* launchRun;
      yield* Deferred.succeed(first, undefined);
      yield* settled({ lastRunStatus: "succeeded", consecutiveFailures: 0 });
      yield* Deferred.fail(second, "Workspace preparation failed: disk full");
      yield* settled({ lastRunStatus: "failed", consecutiveFailures: 1 });
    }).pipe(Effect.provide(failureTrackingLayer({ outcome, notices, pendingPreparations })));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("tells only a live creator thread that is not the bound thread about failed runs", () =>
  Effect.gen(function* () {
    const outcome = yield* Ref.make<LaunchOutcome>("launch-fails");
    const notices = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const cases = [
        { name: "created in Settings", boundThreadId: null, creatorThreadId: undefined },
        { name: "creator was deleted", boundThreadId: null, creatorThreadId: "thread-deleted" },
        {
          name: "bound to its creator",
          boundThreadId: "thread-bound",
          creatorThreadId: "thread-bound",
        },
        {
          name: "bound elsewhere",
          boundThreadId: "thread-bound",
          creatorThreadId: "thread-creator",
        },
      ] as const;
      for (const testCase of cases) {
        const { task } = yield* service.upsert(
          { ...(yield* failingTaskInput(testCase.boundThreadId)), title: testCase.name },
          testCase.creatorThreadId === undefined
            ? {}
            : { creatorThreadId: ThreadId.make(testCase.creatorThreadId) },
        );
        const ran = yield* service.runNow({ id: task.id });
        expect(ran.task, testCase.name).toMatchObject({
          lastRunStatus: "failed",
          consecutiveFailures: 1,
        });
      }
      const notice = yield* Queue.take(notices);
      assert(notice.type === "message.dispatch");
      expect(notice.text).toContain('"bound elsewhere"');
      expect(yield* Queue.size(notices)).toBe(0);

      const { task: oneTime } = yield* service.upsert(
        {
          ...(yield* failingTaskInput(null)),
          title: "one-time",
          schedule: { type: "once", at: "1970-01-01T00:01:00Z" },
        },
        { creatorThreadId: ThreadId.make("thread-creator") },
      );
      yield* TestClock.adjust("2 minutes");
      yield* service.runNow({ id: oneTime.id });
      const oneTimeNotice = yield* Queue.take(notices);
      assert(oneTimeNotice.type === "message.dispatch");
      // Resuming would fail because the time has passed.
      expect(oneTimeNotice.text).toContain("schedule {type:'once',at:<a future time>}");
      expect(oneTimeNotice.text).not.toContain("enabled=true");
    }).pipe(
      Effect.provide(
        failureTrackingLayer({ outcome, notices, deletedThreads: ["thread-deleted"] }),
      ),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
