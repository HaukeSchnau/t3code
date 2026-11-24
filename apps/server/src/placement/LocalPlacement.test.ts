import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, type HostResourcesSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as LocalPlacement from "./LocalPlacement.ts";

const idle: HostResourcesSnapshot = {
  sampledAt: 0,
  cpuUtilization: 0,
  cpuCount: 16,
  availableMemoryBytes: 64 * 1024 ** 3,
  totalMemoryBytes: 64 * 1024 ** 3,
  loadAverage: 0,
};

interface Setup {
  /** Each call to `read` takes the next entry; the last one repeats. `"fail"` dies. */
  readonly resources?: ReadonlyArray<HostResourcesSnapshot | "fail">;
  readonly waitingSince?: string | null;
  readonly endWaitFails?: boolean;
}

const layerFor = (setup: Setup, endedWaits: Ref.Ref<number>, reads: Ref.Ref<number>) =>
  LocalPlacement.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({ placementAgentLimit: 1 }),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-local-placement-" }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId: EnvironmentId.make("env-here"),
            label: "here",
          } as never),
        }),
        Layer.mock(HostResources.HostResources)({
          read: Ref.getAndUpdate(reads, (count) => count + 1).pipe(
            Effect.flatMap((count) => {
              const resources = setup.resources ?? [idle];
              const next = resources[Math.min(count, resources.length - 1)];
              return next === "fail" || next === undefined
                ? Effect.die("no host resources")
                : Effect.succeed(next);
            }),
          ),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () =>
            Effect.succeed({
              placement: {
                waitingSince:
                  setup.waitingSince === undefined
                    ? "2026-11-24T12:00:00.000Z"
                    : setup.waitingSince,
              },
            } as never),
          dispatch: () =>
            setup.endWaitFails === true
              ? Effect.fail("not committed" as never)
              : Ref.update(endedWaits, (count) => count + 1).pipe(Effect.as({} as never)),
        }),
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(NodeServices.layer),
  );

const withPlacement = <A, E>(
  setup: Setup,
  body: (
    placement: LocalPlacement.LocalPlacement["Service"],
    state: { readonly endedWaits: Ref.Ref<number>; readonly reads: Ref.Ref<number> },
  ) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const endedWaits = yield* Ref.make(0);
    const reads = yield* Ref.make(0);
    return yield* Effect.gen(function* () {
      return yield* body(yield* LocalPlacement.LocalPlacement, { endedWaits, reads });
    }).pipe(Effect.provide(layerFor(setup, endedWaits, reads)));
  });

const insertRun = (threadId: string, ordinal: number, status: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES (${`${threadId}-run-${ordinal}`}, ${threadId}, ${ordinal}, 'codex', ${status},
        '2026-11-24T12:00:00.000Z', '{}')
    `;
  });

it.effect("counts a preparing run the room check read, not a waiter that joined after it", () =>
  withPlacement({}, (placement) =>
    Effect.gen(function* () {
      yield* insertRun("thread-starting", 1, "preparing");
      // A waiter whose run is not in the table yet must not cancel out the preparing one.
      const waiter = yield* placement
        .awaitRoom(ThreadId.make("thread-waiting"), 0)
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const load = yield* placement.report();
      assert.equal(load.launchesInFlight, 1);
      assert.equal(load.waiting, 1);
      yield* Fiber.interrupt(waiter);
    }),
  ),
);

it.effect("lets a thread start when start anyway ended its wait before it registered", () =>
  withPlacement({ waitingSince: null }, (placement) =>
    Effect.gen(function* () {
      yield* insertRun("thread-busy", 1, "running");
      const waiter = yield* placement
        .awaitRoom(ThreadId.make("thread-started"), 0)
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(waiter);
    }),
  ),
);

it.effect("keeps a thread waiting while the end of its wait cannot be recorded", () =>
  withPlacement({ endWaitFails: true }, (placement) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-waiting");
      const waiter = yield* placement.awaitRoom(threadId, 0).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      assert.isUndefined(waiter.pollUnsafe());
      const startNow = yield* placement.startNow(threadId).pipe(Effect.flip);
      assert.equal(startNow._tag, "PlacementError");
      assert.isUndefined(waiter.pollUnsafe());
      yield* Fiber.interrupt(waiter);
    }),
  ),
);

it.effect("keeps checking for room after a load read fails", () =>
  withPlacement({ resources: ["fail", idle] }, (placement, { endedWaits, reads }) =>
    Effect.gen(function* () {
      const waiter = yield* placement
        .awaitRoom(ThreadId.make("thread-waiting"), 0)
        .pipe(Effect.forkChild);
      // The first scheduled check reads nothing and must not end the checks.
      yield* TestClock.adjust("10 seconds");
      assert.isAbove(yield* Ref.get(reads), 1);
      yield* Fiber.join(waiter);
      assert.equal(yield* Ref.get(endedWaits), 1);
    }),
  ),
);
