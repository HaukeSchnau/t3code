// @effect-diagnostics nodeBuiltinImport:off -- thread worlds are host directories.
/**
 * T3's side of fleet worlds (patches/worlds.md): a project per configured world, a thread world
 * per thread, Claude's checkout hook, the thread's world state, and teardown that never loses
 * work no remote has (patches/worlds.md).
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import {
  CommandId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type WorldId,
  type WorldSettings,
  type WorldThreadStatus,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  deleteIsolatedWorkspace,
  isolatedWorkspacesAvailable,
} from "../workspace/IsolatedWorkspaces.ts";
import { keepsWorkspace } from "../workspace/ManagedWorkspaces.ts";
import { ManagedWorkspaceError, runWorkspaceCommand } from "../workspace/WorkspaceCommand.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { looseFiles, removeEmptyTree } from "./looseFiles.ts";
import {
  pushThreadWorldNotes,
  registeredThreadKey,
  registerThreadWorld,
  threadWorldNotesState,
} from "./ThreadWorldLauncher.ts";
import {
  isInWorlds,
  isWorldProjectRoot,
  threadWorldOf,
  worldProjectRoot,
} from "./threadWorldPaths.ts";
import {
  type CheckoutOutcome,
  commandDirectories,
  hookDecision,
  worldDirectories,
} from "./worldHook.ts";
import { worldfsRequest, worldfsSocketPath } from "./WorldfsClient.ts";
import {
  decodeDaemonThreadStatus,
  emptyWorldThreadStatus,
  toWorldThreadStatus,
} from "./worldStatus.ts";
import { busyReason, teardownDecision } from "./worldTeardown.ts";
import { WorldThreadHooks } from "./WorldThreadHooks.ts";

const STATUS_TIMEOUT_MS = 15_000;
// A checkout past the free 20 waits for the cap's throttle.
const CHECKOUT_TIMEOUT_MS = 120_000;

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const environment = yield* HostProcess.Environment;
  const available = isolatedWorkspacesAvailable(yield* HostProcess.Platform, environment);
  const context = yield* Effect.context<ProcessRunner.ProcessRunner>();

  const settings = settingsService.getSettings.pipe(Effect.orElseSucceed(() => undefined));

  /** The configured thread world containing `cwd`, with its daemon key once registered. */
  const threadWorld = Effect.fn("ThreadWorlds.threadWorld")(function* (cwd: string) {
    const current = yield* settings;
    if (!available || current === undefined) return undefined;
    const world = threadWorldOf(config.baseDir, current.worlds, cwd);
    if (world === undefined) return undefined;
    const thread = yield* registeredThreadKey(world.root).pipe(
      Effect.provide(context),
      Effect.orElseSucceed(() => undefined),
    );
    return { ...world, thread, socket: worldfsSocketPath(environment) };
  });

  // The last failed notes push per thread world, shown on its notes until a push succeeds.
  const notesErrors = new Map<string, string>();
  const notesLocks = new Map<string, Semaphore.Semaphore>();

  /** The world repo at the thread world's root, as one more repo with work no remote has. */
  const notesRepo = Effect.fn("ThreadWorlds.notesRepo")(function* (
    world: NonNullable<Effect.Success<ReturnType<typeof threadWorld>>>,
  ) {
    if (world.settings.repo === undefined) return [];
    if (!NodeFS.existsSync(NodePath.join(world.root, ".git"))) return [];
    const error = notesErrors.get(world.root);
    const state = yield* threadWorldNotesState(world.root).pipe(
      Effect.provide(context),
      Effect.map((notes) => ({ ...notes, error })),
      Effect.catch((cause) => Effect.succeed({ dirty: 0, ahead: 0, error: cause.message })),
    );
    return [
      {
        repo: world.settings.repo,
        dir: ".",
        checkedOut: true,
        dirty: state.dirty,
        commits: state.ahead,
        branches: [],
        // A state that couldn't be read is never a clean one.
        lostOnTeardown: state.dirty > 0 || state.ahead > 0 || state.error !== undefined,
        ...(state.error === undefined ? {} : { error: state.error }),
      },
    ];
  });

  const readStatus = Effect.fn("ThreadWorlds.readStatus")(function* (
    world: NonNullable<Effect.Success<ReturnType<typeof threadWorld>>>,
  ): Effect.fn.Return<WorldThreadStatus> {
    const daemon = yield* readDaemonStatus(world);
    const notes = yield* notesRepo(world);
    return notes.length === 0 ? daemon : { ...daemon, repos: [...notes, ...daemon.repos] };
  });

  const readDaemonStatus = Effect.fn("ThreadWorlds.readDaemonStatus")(function* (
    world: NonNullable<Effect.Success<ReturnType<typeof threadWorld>>>,
  ): Effect.fn.Return<WorldThreadStatus> {
    if (world.thread === undefined) return emptyWorldThreadStatus(world.id, world.settings.path);
    return yield* worldfsRequest(
      world.socket,
      { method: "status", thread: world.thread },
      STATUS_TIMEOUT_MS,
    ).pipe(
      Effect.flatMap(decodeDaemonThreadStatus),
      Effect.map((status) => toWorldThreadStatus(status, process.pid)),
      // agent-exec registers a thread world with the daemon when it creates it, so a registered
      // world the daemon doesn't know (`unknown-thread`) is unknown state, never a clean one.
      Effect.catch((error) =>
        Effect.succeed({
          ...emptyWorldThreadStatus(world.id, world.settings.path),
          available: false,
          message: error.message,
        }),
      ),
    );
  });

  const status = (cwd: string) =>
    threadWorld(cwd).pipe(
      Effect.flatMap((world) => (world === undefined ? Effect.undefined : readStatus(world))),
      Effect.orElseSucceed(() => undefined),
    );

  const ensure = Effect.fn("ThreadWorlds.ensure")(function* (input: {
    readonly threadId: OrchestrationV2ThreadShell["id"];
    readonly cwd: string | null;
  }) {
    if (input.cwd === null) return;
    if (isWorldProjectRoot(config.baseDir, input.cwd)) {
      return yield* Effect.fail(
        "This thread has no world of its own, so it would run on the host. Start a new thread in this world.",
      );
    }
    const world = yield* threadWorld(input.cwd);
    if (world === undefined || world.thread !== undefined) return;
    const shell = yield* threads
      .getThreadShell(input.threadId)
      .pipe(Effect.mapError((error) => error.message));
    if (shell === null) return yield* Effect.fail("The thread no longer exists.");
    yield* Effect.logInfo("Recreating a thread world", { root: world.root });
    yield* registerThreadWorld({
      root: world.root,
      world: world.id,
      settings: world.settings,
      threadId: input.threadId,
      projectId: shell.projectId,
    }).pipe(
      Effect.provide(context),
      Effect.mapError((error) => error.message),
    );
  });

  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

  const claudePreToolUse = (cwd: string | null): Effect.Effect<HookCallback | undefined> =>
    (cwd === null ? Effect.undefined : threadWorld(cwd)).pipe(
      Effect.map((world) => {
        if (world?.thread === undefined) return undefined;
        const thread = world.thread;
        const checkout = (path: string) =>
          worldfsRequest(
            world.socket,
            { method: "checkout", thread, path },
            CHECKOUT_TIMEOUT_MS,
          ).pipe(
            Effect.as<CheckoutOutcome>({ ok: true }),
            Effect.catch((error) =>
              Effect.succeed<CheckoutOutcome>({
                ok: false,
                code: error.code,
                message: error.message,
              }),
            ),
          );
        const hook: HookCallback = (input, _toolUseId, options) => {
          if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") {
            return Promise.resolve({});
          }
          const command = (input.tool_input as { readonly command?: unknown } | null)?.command;
          if (typeof command !== "string") return Promise.resolve({});
          const directories = worldDirectories(
            commandDirectories(command, input.cwd, NodeOS.homedir()),
            world.settings.path,
          );
          return runPromise(
            Effect.forEach(directories, checkout).pipe(
              Effect.map((outcomes) => hookDecision(outcomes) ?? {}),
            ),
            { signal: options.signal },
          );
        };
        return hook;
      }),
      Effect.orElseSucceed(() => undefined),
    );

  const inWorld = (cwd: string) => Effect.succeed(isInWorlds(config.baseDir, cwd));

  const pushNotes = Effect.fn("ThreadWorlds.pushNotes")(function* (root: string) {
    let lock = notesLocks.get(root);
    if (lock === undefined) {
      lock = yield* Semaphore.make(1);
      notesLocks.set(root, lock);
    }
    yield* lock.withPermits(1)(
      pushThreadWorldNotes(root).pipe(
        Effect.provide(context),
        Effect.tap(() => Effect.sync(() => notesErrors.delete(root))),
        Effect.catch((error) =>
          Effect.sync(() => notesErrors.set(root, error.message)).pipe(
            Effect.andThen(
              Effect.logWarning("Could not push a thread world's notes", {
                root,
                reason: error.message,
              }),
            ),
          ),
        ),
      ),
    );
  });

  // Pushing waits on the network, so the turn's checkpoint doesn't wait for it.
  const turnEnded = (input: {
    readonly threadId: OrchestrationV2ThreadShell["id"];
    readonly cwd: string;
  }) =>
    threadWorld(input.cwd).pipe(
      Effect.flatMap((world) =>
        world?.thread === undefined ||
        world.settings.repo === undefined ||
        !NodeFS.existsSync(NodePath.join(world.root, ".git"))
          ? Effect.void
          : pushNotes(world.root).pipe(Effect.forkDetach, Effect.asVoid),
      ),
      Effect.orElseSucceed(() => undefined),
    );

  return {
    available,
    status,
    ensure,
    inWorld,
    claudePreToolUse,
    readStatus,
    threadWorld,
    turnEnded,
  };
});

/** Provides `WorldThreadHooks` to provider adapters, VCS status and the MCP tools. */
export const layer = Layer.effect(
  WorldThreadHooks,
  make.pipe(
    Effect.map((worlds) => ({
      ensure: worlds.ensure,
      inWorld: worlds.inWorld,
      status: worlds.status,
      claudePreToolUse: worlds.claudePreToolUse,
      turnEnded: worlds.turnEnded,
    })),
  ),
).pipe(Layer.provide(ProcessRunner.layer));

const WORLD_SWEEP_INTERVAL = "10 minutes";

/**
 * Keeps a project for every configured world, and tears down thread worlds whose threads are
 * settled, archived or deleted once nothing in them would be lost.
 */
export const layerBackground = Layer.effectDiscard(
  Effect.gen(function* () {
    const worlds = yield* make;
    if (!worlds.available) return;
    const config = yield* ServerConfig.ServerConfig;
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const projects = yield* ProjectService.ProjectService;
    const threads = yield* ProjectionStore.ProjectionStoreV2;
    const context = yield* Effect.context<ProcessRunner.ProcessRunner>();

    const reconcileProjects = Effect.gen(function* () {
      const current = yield* settingsService.getSettings;
      for (const [id, world] of Object.entries(current.worlds)) {
        yield* reconcileWorld(id, world).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not reconcile a world's project", { world: id, cause }),
          ),
        );
      }
    });

    const reconcileWorld = Effect.fn("ThreadWorlds.reconcileWorld")(function* (
      id: WorldId,
      world: WorldSettings,
    ) {
      const root = worldProjectRoot(config.baseDir, id);
      NodeFS.mkdirSync(root, { recursive: true });
      const existing = yield* projects.getByWorkspaceRoot(root);
      if (Option.isNone(existing)) {
        yield* projects.create({
          commandId: CommandId.make(`world:${NodeCrypto.randomUUID()}`),
          projectId: ProjectId.make(NodeCrypto.randomUUID()),
          title: world.title,
          workspaceRoot: root,
          createWorkspaceRootIfMissing: true,
          world: id,
        });
        yield* Effect.logInfo("Created the project for a world", { world: id });
      } else if (existing.value.title !== world.title) {
        yield* projects.update({
          commandId: CommandId.make(`world:${NodeCrypto.randomUUID()}`),
          projectId: existing.value.id,
          title: world.title,
        });
      }
    });

    const threadUse = (shell: OrchestrationV2ThreadShell) => ({
      active: keepsWorkspace(shell),
      lastActivityMs: Math.max(
        ...[shell.updatedAt, shell.settledAt, shell.archivedAt, shell.latestRunCompletedAt]
          .filter((value) => value != null)
          .map((value) => DateTime.toEpochMillis(value)),
      ),
    });

    /** The world repo's tracked files, when the thread world's root is one. */
    const worldRepoFiles = Effect.fn("ThreadWorlds.worldRepoFiles")(function* (root: string) {
      if (!NodeFS.existsSync(NodePath.join(root, ".git"))) return {};
      const unlisted = (cause?: unknown) =>
        new ManagedWorkspaceError({
          operation: "ThreadWorlds.worldRepoFiles",
          detail: "Could not list the world repo's files.",
          ...(cause === undefined ? {} : { cause }),
        });
      const result = yield* runWorkspaceCommand({
        operation: "ThreadWorlds.worldRepoFiles",
        command: "git",
        args: ["-C", root, "ls-files", "-z"],
        timeout: "30 seconds",
      }).pipe(Effect.provide(context), Effect.mapError(unlisted));
      if (result.code !== 0 || result.stdoutTruncated) {
        return yield* unlisted({
          code: result.code,
          stdoutTruncated: result.stdoutTruncated,
          stderr: result.stderr,
        });
      }
      // Untrimmed: a file name may start or end with a space.
      return { tracked: new Set(result.stdout.split("\0").filter(Boolean)) };
    });

    const allThreads = threads
      .getShellSnapshot()
      .pipe(Effect.map((snapshot) => [...snapshot.threads, ...snapshot.archivedThreads]));

    const sweep = Effect.gen(function* () {
      const current = yield* settingsService.getSettings;
      const shells = yield* allThreads;
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      for (const id of Object.keys(current.worlds)) {
        const parent = worldProjectRoot(config.baseDir, id);
        const names = NodeFS.existsSync(parent)
          ? NodeFS.readdirSync(parent, { withFileTypes: true }).filter((entry) =>
              entry.isDirectory(),
            )
          : [];
        for (const entry of names) {
          const root = NodePath.join(parent, entry.name);
          const world = yield* worlds.threadWorld(root);
          if (world === undefined) continue;
          const users = shells.filter(
            (shell) =>
              shell.worktreePath !== null &&
              threadWorldOf(config.baseDir, current.worlds, shell.worktreePath)?.root === root,
          );
          const createdMs = NodeFS.statSync(root).ctimeMs;
          if (busyReason({ nowMs, createdMs, threads: users.map(threadUse) }) !== undefined) {
            continue;
          }
          // A world whose files can't be listed stays; the sweep goes on with the next one.
          const tracked = yield* worldRepoFiles(root).pipe(
            Effect.catch((error) =>
              Effect.logWarning("A thread world stays", {
                root,
                reason: error.message,
                cause: error.cause,
              }).pipe(Effect.as(null)),
            ),
          );
          if (tracked === null) continue;
          const decision = teardownDecision({
            nowMs,
            createdMs,
            threads: users.map(threadUse),
            status:
              world.thread === undefined
                ? emptyWorldThreadStatus(world.id, world.settings.path)
                : yield* worlds.readStatus(world),
            looseFiles: looseFiles(root, {
              includeRepos: world.thread === undefined,
              ...tracked,
            }),
          });
          if (!decision.teardown) {
            yield* Effect.logDebug("Keeping a thread world", { root, reason: decision.reason });
            continue;
          }
          // Turn startup holds the same lease, so no thread resumes between this check and retire.
          yield* withWorkspaceLease(
            root,
            Effect.gen(function* () {
              const fresh = yield* Effect.forEach(users, (user) => threads.getThreadShell(user.id));
              const busyNow = busyReason({
                nowMs: DateTime.toEpochMillis(yield* DateTime.now),
                createdMs,
                threads: fresh.flatMap((shell) => (shell === null ? [] : [threadUse(shell)])),
              });
              if (busyNow !== undefined) return;
              // An unregistered world goes only while empty, so a file written meanwhile keeps it.
              yield* world.thread === undefined
                ? removeEmptyTree(root)
                : deleteIsolatedWorkspace(root).pipe(Effect.provide(context));
              yield* Effect.logInfo("Tore down a thread world", { root });
            }),
          ).pipe(
            Effect.catch((error) =>
              Effect.logWarning("A thread world stays", { root, reason: error.message }),
            ),
          );
        }
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Thread world sweep failed", { cause })),
    );

    const changes = yield* settingsService.subscribeChanges;
    yield* forkParked(reconcileProjects);
    yield* forkParked(Stream.runForEach(changes, () => reconcileProjects).pipe(Effect.ignoreCause));
    yield* forkParked(
      sweep.pipe(Effect.delay("1 minute"), Effect.repeat(Schedule.spaced(WORLD_SWEEP_INTERVAL))),
    );
  }),
).pipe(Layer.provide(ProcessRunner.layer));
