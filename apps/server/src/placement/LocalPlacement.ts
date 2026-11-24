/**
 * This environment's side of placement (patches/fleet-placement.md): the load it reports to
 * linked peers, and the threads placed here that wait for room before they start.
 */
import {
  CommandId,
  OrchestrationV2CreationSource,
  type PlacementMatch,
  PlacementError,
  type PlacementReport,
  type ProjectId,
  repositoryGroupingKeyOf,
  type ThreadId,
  type ThreadPlacement,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { freeAgentSlots } from "@t3tools/shared/placement";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ServerSettings from "../serverSettings.ts";
import { worldProjectRoot } from "../world/threadWorldPaths.ts";
import { isolatedWorkspacesAvailable } from "../workspace/IsolatedWorkspaces.ts";

/** How often a waiting thread checks for room. */
const ROOM_CHECK_INTERVAL = "3 seconds";

interface Waiter {
  readonly since: number;
  readonly release: Deferred.Deferred<void>;
}

export class LocalPlacement extends Context.Service<
  LocalPlacement,
  {
    /** This environment's load, with the project that fits `match` when one is given. */
    readonly report: (match?: PlacementMatch) => Effect.Effect<PlacementReport>;
    /**
     * Checks a placed launch against this host's load as it is created here, so two deciders
     * that saw the same last slot do not both start: the later one waits. Holds the slot until
     * `release`, by which time the launch's run counts as in flight.
     */
    readonly admit: (placement: ThreadPlacement) => Effect.Effect<{
      readonly placement: ThreadPlacement;
      readonly release: Effect.Effect<void>;
    }>;
    /** Resolves when the thread may start: room freed up here, or someone said start anyway. */
    readonly awaitRoom: (threadId: ThreadId, since: number) => Effect.Effect<void>;
    /** Starts a waiting thread now, whatever the load. */
    readonly startNow: (threadId: ThreadId) => Effect.Effect<void, PlacementError>;
  }
>()("t3/placement/LocalPlacement") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const hostResources = yield* HostResources.HostResources;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const platform = yield* HostProcess.Platform;
  const path = yield* Path.Path;
  const servesWorlds = isolatedWorkspacesAvailable(platform, yield* HostProcess.Environment);
  const waiters = yield* Ref.make<ReadonlyMap<ThreadId, Waiter>>(new Map());
  const admission = yield* Semaphore.make(1);
  const admitted = yield* Ref.make(0);

  const activeRuns = sql<{ readonly thread_id: ThreadId; readonly status: string }>`
    SELECT thread_id, status
    FROM orchestration_v2_projection_runs
    WHERE status IN ('preparing', 'starting', 'running', 'waiting')
  `;

  const projectFor = Effect.fn("LocalPlacement.projectFor")(function* (match: PlacementMatch) {
    switch (match.kind) {
      case "scratch":
        return null;
      case "world": {
        const project = yield* projects.getByWorkspaceRoot(
          worldProjectRoot(config.baseDir, match.world),
        );
        return Option.isSome(project) && project.value.archivedAt == null ? project.value.id : null;
      }
      case "repo": {
        // The project at the same folder of the repository, else the repository's root.
        let root: ProjectId | null = null;
        let cursor: number | null = 0;
        while (cursor !== null) {
          const page: Effect.Success<ReturnType<typeof projects.listPage>> =
            yield* projects.listPage({ cursor, limit: 100 });
          for (const project of page.projects) {
            const identity = project.repositoryIdentity;
            if (
              project.archivedAt != null ||
              project.world != null ||
              identity == null ||
              repositoryGroupingKeyOf(identity) !== match.repository
            ) {
              continue;
            }
            const folder = repositoryFolder(
              path.relative(identity.rootPath ?? project.workspaceRoot, project.workspaceRoot),
            );
            if (folder === repositoryFolder(match.path ?? "")) return project.id;
            if (folder === "" && root === null) root = project.id;
          }
          cursor = page.nextCursor;
        }
        return root;
      }
    }
  });

  const report: LocalPlacement["Service"]["report"] = Effect.fn("LocalPlacement.report")(
    function* (match) {
      const descriptor = yield* environment.getDescriptor;
      const settings = yield* settingsService.getSettings.pipe(Effect.orDie);
      // Unknown occupancy is no room: the report fails rather than claim an empty host.
      const runs = yield* activeRuns.pipe(Effect.orDie);
      // Read after the runs, so a waiter whose run the query missed is never subtracted.
      const queued = yield* Ref.get(waiters);
      const running = runs.filter((run) => run.status !== "preparing").length;
      const preparing = runs.filter(
        (run) => run.status === "preparing" && !queued.has(run.thread_id),
      ).length;
      const projectId: ProjectId | null | undefined =
        match === undefined
          ? undefined
          : yield* projectFor(match).pipe(Effect.orElseSucceed(() => null));
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        platform,
        weight: settings.placementWeight,
        agentLimit: settings.placementAgentLimit,
        resources: yield* hostResources.read,
        runningAgents: running,
        // Waiting threads hold a preparing run, but start no agent until they leave the queue.
        launchesInFlight: preparing + (yield* Ref.get(admitted)),
        waiting: queued.size,
        worlds: servesWorlds ? Object.keys(settings.worlds) : [],
        providers: (yield* providerRegistry.getProviders).flatMap((provider) =>
          provider.enabled && provider.installed ? [provider.instanceId] : [],
        ),
        ...(projectId === undefined ? {} : { projectId }),
      } satisfies PlacementReport;
    },
  );

  const endWait = (threadId: ThreadId) =>
    threads
      .dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`placement:wait-ended:${threadId}`),
        threadId,
        placementWaitEnded: true,
      })
      .pipe(
        Effect.mapError(
          () => new PlacementError({ message: "Could not record that the thread may start." }),
        ),
      );

  const forget = (threadId: ThreadId) =>
    Ref.update(waiters, (current) => {
      const next = new Map(current);
      next.delete(threadId);
      return next;
    });

  // Admission changes the counts it reads: launches taking a slot, waiters leaving the queue and
  // slots handed to persisted runs all happen under one permit, so no two see the same free slot.
  // The wait ends durably before the thread leaves the queue, or a restart would queue it again.
  // Uninterruptible: a waiter out of the queue with its wait unresolved could never start.
  const release = Effect.fn("LocalPlacement.release")(function* (threadId: ThreadId) {
    yield* endWait(threadId);
    const waiter = (yield* Ref.get(waiters)).get(threadId);
    yield* forget(threadId);
    if (waiter !== undefined) yield* Deferred.succeed(waiter.release, undefined);
  }, Effect.uninterruptible);

  const hasRoom = report().pipe(
    Effect.map(
      (load) =>
        freeAgentSlots({
          resources: load.resources,
          runningAgents: load.runningAgents,
          launchesInFlight: load.launchesInFlight,
          agentLimit: load.agentLimit,
        }).slots >= 1,
    ),
    Effect.catchDefect((defect) =>
      Effect.logWarning("Placement could not read this host's load", defect).pipe(Effect.as(false)),
    ),
  );

  /** Starts the longest-waiting thread whenever there is room for one more agent. */
  const admitNext = Effect.gen(function* () {
    const first = [...(yield* Ref.get(waiters)).entries()].toSorted(
      ([, left], [, right]) => left.since - right.since,
    )[0];
    if (first === undefined) return;
    yield* admission.withPermits(1)(
      Effect.gen(function* () {
        if (yield* hasRoom) yield* release(first[0]);
      }),
    );
  });

  // One check per interval for the life of the server; a failed check is no room this time.
  yield* admitNext.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Placement could not check for room", cause)),
    Effect.repeat(Schedule.spaced(ROOM_CHECK_INTERVAL)),
    Effect.forkScoped,
  );

  const awaitRoom: LocalPlacement["Service"]["awaitRoom"] = Effect.fn("LocalPlacement.awaitRoom")(
    function* (threadId, since) {
      const deferred = yield* Deferred.make<void>();
      // Under the permit, so a start anyway either sees this waiter or already ended the wait.
      const waits = yield* admission.withPermits(1)(
        Effect.gen(function* () {
          const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orDie);
          if (shell?.placement?.waitingSince == null) return false;
          yield* Ref.update(waiters, (current) =>
            new Map(current).set(threadId, { since, release: deferred }),
          );
          return true;
        }),
      );
      if (!waits) return;
      yield* Deferred.await(deferred).pipe(Effect.ensuring(forget(threadId)));
    },
  );

  const startNow: LocalPlacement["Service"]["startNow"] = (threadId) =>
    admission.withPermits(1)(release(threadId));

  const admit: LocalPlacement["Service"]["admit"] = Effect.fn("LocalPlacement.admit")(
    function* (placement) {
      if (placement.waitingSince !== null) return { placement, release: Effect.void };
      return yield* admission.withPermits(1)(
        Effect.gen(function* () {
          if (yield* hasRoom) {
            yield* Ref.update(admitted, (count) => count + 1);
            return {
              placement,
              release: admission.withPermits(1)(Ref.update(admitted, (count) => count - 1)),
            };
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          return {
            placement: {
              ...placement,
              reason: `${placement.label} filled up before the thread arrived`,
              waitingSince: now,
            },
            release: Effect.void,
          };
        }),
      );
    },
  );

  return LocalPlacement.of({ report, admit, awaitRoom, startNow });
});

export const layer = Layer.effect(LocalPlacement, make);

/** A folder inside a repository, with `/` whichever platform wrote it. */
export const repositoryFolder = (relative: string) => relative.replaceAll("\\", "/");

/**
 * Where a launch placement sends to a peer came from, so the thread there records it. The peer
 * still treats it as its link's agent launch, which keeps the link's mode checks.
 */
export const PlacementOrigin = Schema.Struct({
  creationSource: OrchestrationV2CreationSource,
  generateTitle: Schema.optional(Schema.Boolean),
});
export type PlacementOrigin = typeof PlacementOrigin.Type;

/**
 * The placement an in-process `t3_thread_launch` stamps on its thread, with the launch's origin
 * when another environment sent it. Only placement sets it, around the launch it decided, so a
 * tool argument can never claim one.
 */
export const PlacementStamp = Context.Reference<
  { readonly placement: ThreadPlacement; readonly origin?: PlacementOrigin } | undefined
>("t3/placement/PlacementStamp", { defaultValue: () => undefined });
