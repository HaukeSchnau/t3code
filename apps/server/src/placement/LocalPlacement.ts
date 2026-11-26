/**
 * This environment's side of placement (patches/fleet-placement.md): the load it reports to
 * linked peers, and the threads placed here that wait for room before they start.
 */
import {
  CommandId,
  OrchestrationV2CreationSource,
  PlacementError,
  type PlacementHydrateRequest,
  type PlacementHydrateResult,
  type PlacementMatch,
  type PlacementReport,
  ProjectId,
  repositoryGroupingKeyOf,
  type ThreadId,
  type ThreadPlacement,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { freeAgentSlots } from "@t3tools/shared/placement";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
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
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ServerSettings from "../serverSettings.ts";
import { worldProjectRoot } from "../world/threadWorldPaths.ts";
import { isolatedWorkspacesAvailable } from "../workspace/IsolatedWorkspaces.ts";

/** How often a waiting thread checks for room. */
const ROOM_CHECK_INTERVAL = "3 seconds";
// The deploy's idle check renews the drain on every retry of a waiting release: every 2 minutes
// on NixOS hosts, every 10 on macOS. A release that no longer waits releases the host after this.
const RELEASE_DRAIN_MS = 15 * 60 * 1000;
/** Where infra keeps every world's repositories (patches/worldfs.md). */
const WORLDS_CACHE = "/var/lib/worlds";
// A clone that borrows a mirror's objects takes seconds; a cold one of a large repository minutes.
const CLONE_TIMEOUT = "15 minutes";
const decodeCatalog = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      repos: Schema.Array(Schema.Struct({ name: Schema.String, mirror: Schema.String })),
    }),
  ),
);

interface Waiter {
  readonly since: number;
  readonly release: Deferred.Deferred<void>;
}

/** `relative` inside `root`, or nothing when it would leave it or touch `.git`. */
export function pathInside(path: Path.Path, root: string, relative: string): string | undefined {
  const target = path.resolve(root, relative);
  const fromRoot = path.relative(root, target);
  return fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(fromRoot) ||
    fromRoot.split(path.sep)[0] === ".git"
    ? undefined
    : target;
}

export class LocalPlacement extends Context.Service<
  LocalPlacement,
  {
    /** This environment's load, with the project that fits `match` when one is given. */
    readonly report: (match?: PlacementMatch) => Effect.Effect<PlacementReport>;
    /**
     * A T3 release waits for this host to be idle: report it as updating, with no room, until the
     * release lands or `RELEASE_DRAIN_MS` passes without another call. Placement passes it over,
     * and threads placed here wait until then. Running threads and explicit launches still run.
     */
    readonly drain: Effect.Effect<void>;
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
    /**
     * A project for a repository this host lacks: a clone that borrows objects
     * from the worlds mirror when one has the repository, with the sender's ignored files.
     */
    readonly hydrate: (
      input: PlacementHydrateRequest,
    ) => Effect.Effect<PlacementHydrateResult, PlacementError>;
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
  const fs = yield* FileSystem.FileSystem;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const random = yield* SecureRandom.SecureRandom;
  const path = yield* Path.Path;
  const servesWorlds = isolatedWorkspacesAvailable(platform, yield* HostProcess.Environment);
  const waiters = yield* Ref.make<ReadonlyMap<ThreadId, Waiter>>(new Map());
  const admission = yield* Semaphore.make(1);
  const admitted = yield* Ref.make(0);
  const drainedUntil = yield* Ref.make(0);
  const updating = Effect.zipWith(
    Clock.currentTimeMillis,
    Ref.get(drainedUntil),
    (now, until) => now < until,
  );

  // Under the admission permit, so a waiter leaving the queue has recorded that before this
  // returns. Then it waits until admitted launches have recorded their runs, which the idle check
  // that follows reads. The deploy's task timeout bounds that wait; a check it cuts off defers.
  const drain: LocalPlacement["Service"]["drain"] = Effect.gen(function* () {
    const wasUpdating = yield* admission.withPermits(1)(
      Effect.gen(function* () {
        const was = yield* updating;
        yield* Ref.set(drainedUntil, (yield* Clock.currentTimeMillis) + RELEASE_DRAIN_MS);
        return was;
      }),
    );
    if (!wasUpdating) {
      yield* Effect.logInfo("A T3 release waits for this host; it takes no placed threads");
    }
    yield* Ref.get(admitted).pipe(
      Effect.repeat({ until: (count) => count === 0, schedule: Schedule.spaced("100 millis") }),
    );
  });

  const activeRuns = sql<{ readonly thread_id: ThreadId; readonly status: string }>`
    SELECT thread_id, status
    FROM orchestration_v2_projection_runs
    WHERE status IN ('preparing', 'starting', 'running', 'waiting')
  `;

  const projectFor = Effect.fn("LocalPlacement.projectFor")(function* (
    match: PlacementMatch,
    // Only the project at that folder, not the repository's root in its place.
    exact = false,
  ) {
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
            if (folder === "" && root === null && !exact) root = project.id;
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
        // The hydrate route refuses below full access, so a host under a lower ceiling says so.
        // Cold clones and their env-file guards are built for POSIX hosts only.
        canClone:
          platform !== "win32" &&
          (settingsService.managedPolicy?.limits?.maxRuntimeMode ?? "full-access") ===
            "full-access",
        providers: (yield* providerRegistry.getProviders).flatMap((provider) =>
          provider.enabled && provider.installed ? [provider.instanceId] : [],
        ),
        updating: yield* updating,
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
          updating: load.updating,
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

  const failure = (message: string) => new PlacementError({ message });

  /** The worlds mirror of `repository`, whose objects a clone borrows so it takes seconds. */
  const mirrorFor = Effect.fn("LocalPlacement.mirrorFor")(function* (repository: string) {
    const worlds = yield* fs.readDirectory(WORLDS_CACHE).pipe(Effect.orElseSucceed(() => []));
    for (const world of worlds) {
      const catalog = Option.getOrUndefined(
        decodeCatalog(
          yield* fs
            .readFileString(path.join(WORLDS_CACHE, world, "catalog.json"))
            .pipe(Effect.orElseSucceed(() => "")),
        ),
      );
      const found = catalog?.repos.find(
        (repo) => repo.name.toLowerCase() === repository.toLowerCase(),
      );
      if (
        found !== undefined &&
        (yield* fs.exists(found.mirror).pipe(Effect.orElseSucceed(() => false)))
      ) {
        return found.mirror;
      }
    }
    return undefined;
  });

  const inside = (root: string, relative: string) => pathInside(path, root, relative);

  // One clone at a time: two launches for one repository must not clone it twice.
  const cloning = yield* Semaphore.make(1);

  const hydrate: LocalPlacement["Service"]["hydrate"] = Effect.fn("LocalPlacement.hydrate")(
    function* (input) {
      if (platform === "win32") {
        return yield* failure("This machine does not clone repositories for placement.");
      }
      return yield* cloning.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* projectFor(
            { kind: "repo", repository: input.repository, path: input.path },
            true,
          ).pipe(Effect.orElseSucceed(() => null));
          if (existing !== null) return { projectId: existing };
          const segments = input.repository
            .split("/")
            .filter((segment) => segment !== "" && segment !== "." && segment !== "..");
          const repoRoot = path.join(config.baseDir, "placement", "repos", ...segments);
          const workspaceRoot = input.path === "" ? repoRoot : inside(repoRoot, input.path);
          if (workspaceRoot === undefined)
            return yield* failure("The project path leaves its repository.");
          const git = (args: ReadonlyArray<string>) =>
            processRunner
              .run({
                command: "git",
                args,
                env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
                timeout: CLONE_TIMEOUT,
                timeoutBehavior: "timedOutResult",
              })
              .pipe(
                Effect.mapError(() => failure(`Could not run git for ${input.repository}.`)),
                Effect.flatMap((result) =>
                  result.timedOut || result.code !== 0
                    ? // Git's output names this machine's folders, so it stays in the log.
                      Effect.logWarning("Placement's git failed", {
                        repository: input.repository,
                        command: args[0] === "-C" ? args[2] : args[0],
                        code: result.code,
                        timedOut: result.timedOut,
                      }).pipe(
                        Effect.andThen(Effect.fail(failure(`Cloning ${input.repository} failed.`))),
                      )
                    : Effect.succeed(result.stdout.trim()),
                ),
              );
          const cloned = yield* fs.exists(repoRoot).pipe(Effect.orElseSucceed(() => false));
          if (cloned) {
            // Only a checkout of this repository at exactly this folder is reused.
            const realRepoRoot = yield* fs
              .realPath(repoRoot)
              .pipe(Effect.mapError(() => failure("Could not read the clone's folder.")));
            const checkout = yield* Effect.all([
              git(["-C", repoRoot, "rev-parse", "--show-toplevel"]),
              // As configured: `remote get-url` applies this machine's `insteadOf` rewrites. Git
              // fetches from the first of several, so only a single one is trusted.
              git(["-C", repoRoot, "config", "--null", "--get-all", "remote.origin.url"]),
            ]).pipe(Effect.option);
            // A linked worktree's `.git` is a file pointing elsewhere, and a symlinked one leads
            // elsewhere too; rules and copies would land there.
            const dotGit = path.join(repoRoot, ".git");
            const gitDir = yield* fs.stat(dotGit).pipe(Effect.option);
            const gitDirIsLink = yield* fs.readLink(dotGit).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            );
            if (
              Option.isNone(gitDir) ||
              gitDir.value.type !== "Directory" ||
              gitDirIsLink ||
              Option.isNone(checkout) ||
              checkout.value[0] !== realRepoRoot ||
              // NUL-terminated, so an empty or second URL cannot hide in trimmed whitespace.
              checkout.value[1] !== `${input.remoteUrl}\0`
            ) {
              return yield* failure(
                `This machine's folder for ${input.repository} is not a clone of it.`,
              );
            }
          } else {
            yield* fs
              .makeDirectory(path.dirname(repoRoot), { recursive: true })
              .pipe(Effect.mapError(() => failure("Could not make the folder for the clone.")));
            // Staged beside its place, so a failed clone never leaves a checkout that looks ready.
            const staging = `${repoRoot}.cloning-${yield* random.uuidV4()}`;
            yield* Effect.gen(function* () {
              const mirror = yield* mirrorFor(input.repository);
              // From the forge, borrowing the worlds mirror's objects so only what it lacks travels. The
              // mirror keeps forge branches under refs/remotes and its own under refs/heads, so it
              // is never the clone's source.
              yield* git([
                "clone",
                // A mirror that is no longer a usable repository falls back to a plain clone.
                ...(mirror === undefined ? [] : ["--reference-if-able", mirror]),
                "--",
                input.remoteUrl,
                staging,
              ]);
              // A folder the default branch lacks would leave a checkout that never gets it.
              const stagedRoot = input.path === "" ? staging : inside(staging, input.path);
              const staged =
                stagedRoot === undefined
                  ? undefined
                  : yield* Effect.all([
                      fs.realPath(staging),
                      fs.realPath(stagedRoot),
                      fs.stat(stagedRoot),
                    ]).pipe(Effect.option, Effect.map(Option.getOrUndefined));
              if (
                staged === undefined ||
                staged[2].type !== "Directory" ||
                (staged[1] !== staged[0] &&
                  pathInside(path, staged[0], path.relative(staged[0], staged[1])) === undefined)
              ) {
                return yield* failure(`${input.repository} has no folder ${input.path}.`);
              }
              yield* fs
                .rename(staging, repoRoot)
                .pipe(Effect.mapError(() => failure("Could not move the clone into place.")));
            }).pipe(
              Effect.onError(() => fs.remove(staging, { recursive: true }).pipe(Effect.ignore)),
            );
          }
          const project = yield* projects
            .getByWorkspaceRoot(workspaceRoot)
            .pipe(Effect.mapError(() => failure("Could not read projects.")));
          if (Option.isSome(project)) {
            // An archived clone stays archived; placement does not bring it back.
            if (project.value.archivedAt != null) {
              return yield* failure(`The clone of ${input.repository} here is archived.`);
            }
          }
          // Paths are checked again on disk: a checked-out symlink must not carry a write outside.
          const [realRepoRoot, realRoot] = yield* Effect.all([
            fs.realPath(repoRoot),
            fs.realPath(workspaceRoot),
          ]).pipe(Effect.mapError(() => failure("The clone has no such project folder.")));
          if (
            realRoot !== realRepoRoot &&
            pathInside(path, realRepoRoot, path.relative(realRepoRoot, realRoot)) === undefined
          ) {
            return yield* failure("The project folder leaves its clone.");
          }
          const isLink = (candidate: string) =>
            fs.readLink(candidate).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            );
          const gitSays = (args: ReadonlyArray<string>) =>
            processRunner
              .run({
                command: "git",
                args: ["-C", realRepoRoot, ...args],
                timeout: CLONE_TIMEOUT,
                timeoutBehavior: "timedOutResult",
              })
              .pipe(
                Effect.map((result) => !result.timedOut && result.code === 0),
                Effect.orElseSucceed(() => false),
              );
          // A copied secret stays out of commits and checkpoints only while the clone ignores it,
          // by its own rules: this host's global excludes can change without the clone knowing.
          const ignoredHere = (relative: string) =>
            gitSays([
              "-c",
              "core.excludesFile=/dev/null",
              "check-ignore",
              "-q",
              "--no-index",
              "--",
              relative,
            ]);
          // A path Git tracks is committed whatever ignores it, even while missing from disk, and
          // a case-insensitive checkout writes a differently cased name onto it.
          const listed = (args: ReadonlyArray<string>) =>
            processRunner
              .run({
                command: "git",
                args: ["-C", realRepoRoot, ...args],
                timeout: CLONE_TIMEOUT,
                timeoutBehavior: "timedOutResult",
              })
              .pipe(
                Effect.map((result) =>
                  result.timedOut || result.code !== 0
                    ? undefined
                    : result.stdout.split("\0").filter((entry) => entry !== ""),
                ),
                Effect.orElseSucceed(() => undefined),
              );
          const indexed = yield* listed(["ls-files", "-z"]);
          const committed = yield* listed(["ls-tree", "-r", "-z", "--name-only", "HEAD"]);
          // Unknown means nothing is copied.
          const tracked =
            indexed === undefined || committed === undefined
              ? undefined
              : new Set([...indexed, ...committed].map((entry) => entry.toLowerCase()));
          const gitExclude = path.resolve(
            realRepoRoot,
            yield* git(["-C", realRepoRoot, "rev-parse", "--git-path", "info/exclude"]),
          );
          // Git may resolve it elsewhere (a `commondir`, a symlinked `info`): rules and staged
          // copies only ever go inside this clone's own `.git`, as the folder really resolves.
          const ownGitDir = path.join(realRepoRoot, ".git");
          const insideOwnGitDir = (folder: string) => {
            const relative = path.relative(ownGitDir, folder);
            return !relative.startsWith("..") && !path.isAbsolute(relative);
          };
          const elsewhere = failure(
            `The clone of ${input.repository} keeps its git data elsewhere.`,
          );
          const unreadable = () => failure("Could not read the clone's git folder.");
          // Checked before anything is made: the parent as it really resolves, then the folder.
          const infoParent = yield* fs
            .realPath(path.dirname(path.dirname(gitExclude)))
            .pipe(Effect.mapError(unreadable));
          if (!insideOwnGitDir(infoParent)) return yield* elsewhere;
          const infoFolder = path.join(infoParent, path.basename(path.dirname(gitExclude)));
          yield* fs.makeDirectory(infoFolder).pipe(
            Effect.catchIf(
              (error) => error._tag === "PlatformError" && error.reason._tag === "AlreadyExists",
              () => Effect.void,
            ),
            Effect.mapError(unreadable),
          );
          const excludeDir = yield* fs.realPath(infoFolder).pipe(Effect.mapError(unreadable));
          if (!insideOwnGitDir(excludeDir)) return yield* elsewhere;
          const excludeFile = path.join(excludeDir, path.basename(gitExclude));
          for (const file of input.files) {
            // A line break would turn the path into extra rules in the clone's exclude file.
            const target = inside(realRoot, file.path);
            // As the clone's exclude file sees it; a line break anywhere would add rules there.
            const relative =
              target === undefined
                ? undefined
                : path.relative(realRepoRoot, target).split(path.sep).join("/");
            const contents = Buffer.from(file.contents, "base64");
            if (
              target === undefined ||
              relative === undefined ||
              /[\u0000-\u001f\u007f]/.test(relative) ||
              !COPIED_FILE_NAME.test(path.basename(target)) ||
              contents.byteLength > COPIED_FILE_MAX_BYTES
            ) {
              continue;
            }
            const written = yield* Effect.gen(function* () {
              // Each folder on the way is a real folder in the clone before anything is made in it.
              let folder = realRoot;
              for (const segment of path.relative(realRoot, path.dirname(target)).split(path.sep)) {
                if (segment === "") continue;
                folder = path.join(folder, segment);
                if (yield* isLink(folder)) return false;
                const info = yield* fs.stat(folder).pipe(Effect.option);
                if (Option.isNone(info)) yield* fs.makeDirectory(folder);
                else if (info.value.type !== "Directory") return false;
              }
              if (yield* isLink(target)) return false;
              if (tracked === undefined || tracked.has(relative.toLowerCase())) return false;
              // A rule of this checkout's own, even when a .gitignore covers the file now: a branch
              // without that rule must not stage it.
              const rule = `/${gitPatternLiteral(relative)}`;
              const excluded = yield* fs.readFileString(excludeFile).pipe(
                Effect.catchIf(
                  (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
                  () => Effect.succeed(""),
                ),
              );
              if (!excluded.split("\n").includes(rule)) {
                // Replaced whole, so a failed write never drops the rules already there.
                const nextExcluded = `${excludeFile}.${yield* random.uuidV4()}`;
                yield* fs
                  .writeFileString(
                    nextExcluded,
                    `${excluded}${excluded === "" || excluded.endsWith("\n") ? "" : "\n"}${rule}\n`,
                  )
                  .pipe(
                    Effect.andThen(fs.rename(nextExcluded, excludeFile)),
                    Effect.onError(() => fs.remove(nextExcluded).pipe(Effect.ignore)),
                  );
              }
              // The clone's own rules can still unignore it; then it is not copied.
              if (!(yield* ignoredHere(relative))) return false;
              // Written whole in the git folder, where nothing is committed, then linked into
              // place, which never replaces a file: one already there is tracked by the clone or
              // this host's own. When the link works, a full disk leaves no partial file a retry
              // would take as done; when it cannot, the file is written in place.
              const staged = path.join(
                path.dirname(excludeFile),
                `t3-copy-${yield* random.uuidV4()}`,
              );
              // A failed write after `wx` created the file leaves no partial copy behind.
              const writeDirectly = fs
                .writeFile(target, contents, { flag: "wx", mode: 0o600 })
                .pipe(
                  Effect.tapError((error) =>
                    error.reason._tag === "AlreadyExists"
                      ? Effect.void
                      : fs.remove(target).pipe(Effect.ignore),
                  ),
                );
              return yield* fs.writeFile(staged, contents, { flag: "wx", mode: 0o600 }).pipe(
                Effect.andThen(
                  fs.link(staged, target).pipe(
                    // No hard link there (another filesystem, or none supported): written in place.
                    Effect.catchIf(
                      (error) => error.reason._tag !== "AlreadyExists",
                      () => writeDirectly,
                    ),
                  ),
                ),
                Effect.as(true),
                Effect.catchIf(
                  (error) => error.reason._tag === "AlreadyExists",
                  () => Effect.succeed(false),
                ),
                Effect.ensuring(fs.remove(staged).pipe(Effect.ignore)),
              );
            }).pipe(Effect.mapError(() => failure(`Could not copy ${file.path}.`)));
            if (!written)
              yield* Effect.logWarning(
                "Placement skipped a copied file it could not keep private",
                {
                  path: file.path,
                },
              );
          }
          if (Option.isSome(project)) return { projectId: project.value.id };
          const created = yield* projects
            .create({
              commandId: CommandId.make(`placement:hydrate:${yield* random.uuidV4()}`),
              projectId: ProjectId.make(yield* random.uuidV4()),
              title: input.title,
              workspaceRoot,
            })
            .pipe(
              Effect.tapError((error) =>
                Effect.logWarning("Placement could not add the clone as a project", error),
              ),
              Effect.mapError(() =>
                failure(`Could not add the clone of ${input.repository} as a project.`),
              ),
            );
          return { projectId: created.id };
        }),
      );
    },
  );

  return LocalPlacement.of({ report, drain, admit, awaitRoom, startNow, hydrate });
});

export const layer = Layer.effect(LocalPlacement, make).pipe(Layer.provide(ProcessRunner.layer));

/** Env files are the ignored files a new clone almost always needs; others stay put. */
export const COPIED_FILE_NAME = /^(?:\.env(?:\..+)?|\.envrc|\.dev\.vars)$/;
export const COPIED_FILE_MAX_BYTES = 1024 * 1024;

/** `relative` as a gitignore pattern that matches only that path. */
const gitPatternLiteral = (relative: string) => relative.replace(/[\\*?[\] ]/g, "\\$&");

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
