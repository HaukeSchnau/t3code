import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as FollowUpGardener from "./FollowUpGardener.ts";
import * as FollowUps from "./FollowUps.ts";

const home = EnvironmentId.make("env:srv-2");

it.effect("starts the nightly pass once after its time, and again only the next night", () =>
  Effect.gen(function* () {
    const ticks = yield* Ref.make<ReadonlyArray<Effect.Effect<void>>>([]);
    const launched = yield* Ref.make<ReadonlyArray<string>>([]);
    const activeThreads = yield* Ref.make<ReadonlySet<string>>(new Set());
    const scheduler = Layer.succeed(Scheduler.Scheduler, {
      register: <E, R>(_name: string, work: Effect.Effect<void, E, R>) =>
        Effect.gen(function* () {
          const context = yield* Effect.context<R>();
          yield* Ref.update(ticks, (current) => [
            ...current,
            work.pipe(Effect.provideContext(context), Effect.ignore),
          ]);
        }),
    });
    const tick = Ref.get(ticks).pipe(Effect.flatMap((all) => Effect.all(all, { discard: true })));

    // The gardener keeps the server's local time, so the test does too.
    const local = (day: number, hour: number, minute = 0) =>
      DateTime.toEpochMillis(
        DateTime.makeZonedUnsafe(
          { year: 2026, month: 11, day, hour, minute },
          {
            timeZone: DateTime.zoneMakeLocal(),
            adjustForTimeZone: true,
          },
        ),
      );
    yield* TestClock.setTime(local(12, 22));
    yield* Effect.gen(function* () {
      const followUps = yield* FollowUps.FollowUps;
      const gardener = yield* FollowUpGardener.FollowUpGardener;
      // No pass ran since this morning's 03:30, so one starts now, and only one.
      yield* tick;
      yield* tick;
      // Run now while that pass still works answers with it instead of starting another.
      yield* Ref.set(activeThreads, new Set(["thread:1"]));
      const running = yield* gardener.runNow;
      assert.strictEqual(running.thread.threadId, ThreadId.make("thread:1"));
      yield* Ref.set(activeThreads, new Set());
      yield* TestClock.setTime(local(13, 3, 29));
      yield* tick;
      assert.lengthOf(yield* Ref.get(launched), 1);
      yield* TestClock.setTime(local(13, 3, 31));
      yield* tick;
      yield* tick;
      assert.lengthOf(yield* Ref.get(launched), 2);
      const last = (yield* followUps.snapshot({})).lastGardenerRun;
      assert.deepEqual(last?.thread, { environmentId: home, threadId: ThreadId.make("thread:2") });
      assert.isTrue(
        yield* followUps.isGardenerThread({
          environmentId: home,
          threadId: ThreadId.make("thread:1"),
        }),
      );
    }).pipe(
      Effect.provide(
        FollowUpGardener.layer.pipe(
          Layer.provideMerge(FollowUps.layer),
          Layer.provide(
            Layer.mergeAll(
              scheduler,
              Layer.succeed(ServerConfig, {
                followUpGardenerAt: "03:30",
              } as ServerConfig["Service"]),
              Layer.mock(ServerEnvironment.ServerEnvironment)({
                getEnvironmentId: Effect.succeed(home),
              }),
              Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                namedProjectsRoot: "",
                ensureScratchProject: Effect.succeed({ projectId: ProjectId.make("scratch") }),
              }),
              Layer.mock(ProjectService.ProjectService)({
                getById: () => Effect.succeedNone,
              }),
              Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
              ServerSettings.layerTest({
                defaultModelSelection: {
                  instanceId: ProviderInstanceId.make("claudeAgent"),
                  model: "claude-opus-5-5",
                },
              }),
              Layer.mock(ThreadManagementService.ThreadManagementService)({
                getThreadShell: (threadId) =>
                  Ref.get(activeThreads).pipe(
                    Effect.map((active) =>
                      active.has(threadId) ? ({ activityRunStatus: "waiting" } as never) : null,
                    ),
                  ),
              }),
              Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                launch: (input) =>
                  Ref.updateAndGet(launched, (current) => [
                    ...current,
                    input.initialMessage?.text ?? "",
                  ]).pipe(
                    Effect.map(
                      (all) => ({ threadId: ThreadId.make(`thread:${all.length}`) }) as never,
                    ),
                  ),
              }),
            ),
          ),
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          Layer.provide(SqlitePersistence.layerMemory),
        ),
      ),
    );
  }),
);
