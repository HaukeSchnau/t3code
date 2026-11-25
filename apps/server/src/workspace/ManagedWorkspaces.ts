// @effect-diagnostics nodeBuiltinImport:off -- workspace kinds are recognised from on-disk markers.
/**
 * The fork's workspaces next to upstream's Git worktrees (patches/workspaces.md). Git projects and
 * plain directories that track Git folders keep upstream's worktrees; jj repositories get a jj
 * workspace and other directories a guarded copy. A launch can opt a jj or directory project into
 * an isolated agent-exec runtime on Linux hosts with the launcher.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  type ChatAttachment,
  type GitCommandError,
  type ManagedWorkspaceLaunchStrategy,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type TaskFolderError,
  type ThreadId,
  type VcsRemoveWorktreeInput,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { checkDirectoryCopy, createDirectoryCopy } from "./DirectoryCopyWorkspaces.ts";
import {
  createIsolatedWorkspace,
  deleteIsolatedWorkspace,
  findIsolatedWorkspace,
  isolatedWorkspacesAvailable,
  isRegistered,
} from "./IsolatedWorkspaces.ts";
import { findRepositoryMarker } from "../vcs/RepositoryMarker.ts";
import { removeEmptyTree } from "../world/looseFiles.ts";
import { registerThreadWorld } from "../world/ThreadWorldLauncher.ts";
import {
  isWorldProjectRoot,
  threadWorldOf,
  worldOfProjectRoot,
  worldThreadKey,
} from "../world/threadWorldPaths.ts";
import { createJjWorkspace, deleteJjWorkspace, listJjWorkspaces } from "./JjWorkspaces.ts";
import * as TaskFolders from "./TaskFolders.ts";
import { ManagedWorkspaceError, removeWorkspaceDirectory } from "./WorkspaceCommand.ts";
import {
  fallbackWorkspaceSeed,
  slug,
  withWorkspaceReservation,
  type WorkspaceNameError,
} from "./WorkspaceNaming.ts";

type WorkspaceBackend = "git" | "jj" | "directory" | "isolated" | "world";

/** The launch strategy for a new managed workspace, inside `ThreadLaunchService`. */
export type ManagedWorkspaceStrategy = ManagedWorkspaceLaunchStrategy & {
  readonly branch?: undefined;
};

type LaunchWorkspaceStrategy =
  | { readonly type: "root"; readonly branch?: string | undefined }
  | {
      readonly type: "existing_worktree";
      readonly worktreePath: string;
      readonly branch?: string | undefined;
    }
  | {
      readonly type: "worktree";
      readonly baseRef: string;
      readonly branch?: string | undefined;
      readonly startFromOrigin?: boolean | undefined;
      readonly repositories?: ReadonlyArray<{ readonly path: string }> | undefined;
    }
  | ManagedWorkspaceStrategy;

/** A launch's backend, with the plan that upstream's worktrees (`git`) are provisioned from. */
export interface LaunchBackend {
  readonly backend: WorkspaceBackend;
  /** Null unless `git` gives the project a task folder. */
  readonly taskPlan: TaskFolders.TaskFolderPlan | null;
}

export interface CreateManagedWorkspaceInput {
  readonly projectId: ProjectId;
  readonly projectRoot: string;
  readonly threadId: ThreadId;
  /** Semantic seed for the directory name; a first message yields a generated title. */
  readonly title: string;
  readonly message?: {
    readonly text: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
  };
  readonly baseRef?: string | undefined;
  readonly startFromOrigin?: boolean | undefined;
  readonly isolated?: boolean | undefined;
  readonly profile?: ManagedWorkspaceLaunchStrategy["profile"];
}

export class ManagedWorkspaces extends Context.Service<
  ManagedWorkspaces,
  {
    readonly backendFor: (
      projectRoot: string,
      options?: { readonly isolated?: boolean | undefined },
    ) => Effect.Effect<WorkspaceBackend>;
    /**
     * The backend a new thread workspace gets, which launches and handoffs share: `backendFor`,
     * except that a plain directory with a task-folder plan gets upstream's worktrees (`git`).
     * Callers provision from the returned plan, so the folders cannot change in between.
     */
    readonly launchBackendFor: (input: {
      readonly projectId: ProjectId;
      readonly projectRoot: string;
      readonly isolated?: boolean | undefined;
      readonly repositories?: ReadonlyArray<{ readonly path: string }> | undefined;
    }) => Effect.Effect<LaunchBackend, TaskFolderError>;
    /** Whether threads in the project at `projectRoot` each get their own thread world. */
    readonly isWorldProject: (projectRoot: string) => Effect.Effect<boolean>;
    /** Whether `path` lies inside an agent-exec registration (isolated workspace or separate project). */
    readonly isIsolated: (path: string) => Effect.Effect<boolean, ManagedWorkspaceError>;
    /**
     * New workspaces that `launchBackendFor` gives a managed backend become `workspace`
     * launches; a `workspace` launch it gives upstream's worktrees becomes a `worktree` launch
     * from the given or current branch. `taskPlan` is the task folder a `worktree` result gets.
     */
    readonly resolveLaunchStrategy: <S extends LaunchWorkspaceStrategy>(input: {
      readonly projectId: ProjectId;
      readonly projectRoot: string;
      readonly strategy: S;
    }) => Effect.Effect<
      {
        readonly strategy:
          | S
          | Extract<LaunchWorkspaceStrategy, { readonly type: "worktree" }>
          | ManagedWorkspaceStrategy;
        readonly taskPlan: TaskFolders.TaskFolderPlan | null;
      },
      ManagedWorkspaceError | TaskFolderError
    >;
    /** Fails now when `strategy` would need a directory copy that `create` would refuse. */
    readonly checkCopy: (input: {
      readonly projectId: ProjectId;
      readonly projectRoot: string;
      readonly strategy: LaunchWorkspaceStrategy;
    }) => Effect.Effect<void, ManagedWorkspaceError>;
    readonly create: (
      input: CreateManagedWorkspaceInput,
    ) => Effect.Effect<
      { readonly worktreePath: string; readonly backend: WorkspaceBackend },
      ManagedWorkspaceError | WorkspaceNameError
    >;
    /** Removes a workspace this server just created for a cancelled launch. */
    readonly discard: (path: string) => Effect.Effect<void, ManagedWorkspaceError>;
    /**
     * Explicit deletion. Managed workspaces refuse while an active or running
     * thread uses them; other paths go to upstream's Git worktree removal.
     */
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, ManagedWorkspaceError | GitCommandError>;
  }
>()("t3/workspace/ManagedWorkspaces") {}

const ACTIVE_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);

function isInside(candidate: string, parent: string): boolean {
  const relative = NodePath.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

/** Settlement and archiving hide a workspace; neither releases files a running turn uses. */
export function keepsWorkspace(thread: OrchestrationV2ThreadShell): boolean {
  return (
    (thread.archivedAt === null && thread.settledOverride !== "settled") ||
    ACTIVE_RUN_STATUSES.has(thread.activityRunStatus ?? "")
  );
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const taskFolders = yield* TaskFolders.TaskFolders;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const sql = yield* SqlClient.SqlClient;
  const context = yield* Effect.context<ProcessRunner.ProcessRunner>();
  const launcherHost = isolatedWorkspacesAvailable(
    yield* HostProcess.Platform,
    yield* HostProcess.Environment,
  );
  const workspacesRoot = NodePath.join(config.baseDir, "workspaces");

  const fail = (operation: string, detail: string, cause?: unknown) =>
    new ManagedWorkspaceError({ operation, detail, ...(cause === undefined ? {} : { cause }) });

  const isIsolated: ManagedWorkspaces["Service"]["isIsolated"] = (path) =>
    isRegistered(path).pipe(Effect.provide(context));

  const worlds = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.worlds),
    Effect.orElseSucceed(() => ({})),
  );

  const worldOf = (projectRoot: string) =>
    worlds.pipe(Effect.map((all) => worldOfProjectRoot(config.baseDir, all, projectRoot)));

  // By path, not settings: a world removed from settings keeps its threads out of the host root.
  const isWorldProject: ManagedWorkspaces["Service"]["isWorldProject"] = (projectRoot) =>
    Effect.succeed(isWorldProjectRoot(config.baseDir, projectRoot));

  const backendFor: ManagedWorkspaces["Service"]["backendFor"] = Effect.fn(
    "ManagedWorkspaces.backendFor",
  )(function* (projectRoot, options) {
    if (yield* isWorldProject(projectRoot)) return "world";
    const kind = findRepositoryMarker(projectRoot)?.kind ?? "directory";
    if (kind === "git") return kind;
    if (options?.isolated === true) return "isolated";
    // A separate project's workspaces stay inside its environment, like its own threads. An
    // unreadable registry counts as separate, as ProjectExecution does, so nothing lands on the host.
    const separate =
      launcherHost && (yield* isIsolated(projectRoot).pipe(Effect.orElseSucceed(() => true)));
    return separate ? "isolated" : kind;
  });

  const launchBackendFor: ManagedWorkspaces["Service"]["launchBackendFor"] = Effect.fn(
    "ManagedWorkspaces.launchBackendFor",
  )(function* (input) {
    const backend = yield* backendFor(input.projectRoot, { isolated: input.isolated });
    if (backend !== "git" && backend !== "directory") return { backend, taskPlan: null };
    const taskPlan = yield* taskFolders.plan({
      projectId: input.projectId,
      repositories: input.repositories,
    });
    return { backend: taskPlan === null ? backend : "git", taskPlan };
  });

  const strategyBackend = (input: {
    readonly projectId: ProjectId;
    readonly projectRoot: string;
    readonly strategy: LaunchWorkspaceStrategy & { readonly type: "worktree" | "workspace" };
  }) =>
    launchBackendFor({
      projectId: input.projectId,
      projectRoot: input.projectRoot,
      isolated: input.strategy.type === "workspace" && input.strategy.isolated === true,
      repositories: input.strategy.type === "worktree" ? input.strategy.repositories : undefined,
    });

  const resolveLaunchStrategy: ManagedWorkspaces["Service"]["resolveLaunchStrategy"] = Effect.fn(
    "ManagedWorkspaces.resolveLaunchStrategy",
  )(function* (input) {
    const strategy: LaunchWorkspaceStrategy = input.strategy;
    if (strategy.type !== "worktree" && strategy.type !== "workspace")
      return { strategy: input.strategy, taskPlan: null };
    const isolated = strategy.type === "workspace" && strategy.isolated === true;
    const { backend, taskPlan } = yield* strategyBackend({ ...input, strategy });
    if (backend !== "git") {
      return {
        strategy: {
          type: "workspace" as const,
          baseRef: strategy.baseRef,
          ...(strategy.startFromOrigin === undefined
            ? {}
            : { startFromOrigin: strategy.startFromOrigin }),
          ...(isolated ? { isolated: true } : {}),
          ...(isolated && strategy.profile !== undefined ? { profile: strategy.profile } : {}),
        } satisfies ManagedWorkspaceStrategy,
        taskPlan: null,
      };
    }
    if (isolated) {
      return yield* fail(
        "ManagedWorkspaces.resolveLaunchStrategy",
        "Isolated workspaces are for jj and non-Git projects. Git projects get worktrees.",
      );
    }
    if (strategy.type === "worktree") return { strategy: input.strategy, taskPlan };
    const baseRef =
      strategy.baseRef ??
      (yield* git.localStatus({ cwd: input.projectRoot }).pipe(
        // `HEAD` starts each repository of a plain folder from its own default branch.
        Effect.map((status) => (status.isRepo ? (status.refName ?? undefined) : "HEAD")),
        Effect.mapError((cause) =>
          fail(
            "ManagedWorkspaces.resolveLaunchStrategy",
            "Could not read the current branch.",
            cause,
          ),
        ),
      ));
    if (baseRef === undefined) {
      return yield* fail(
        "ManagedWorkspaces.resolveLaunchStrategy",
        "Select a base branch for the new worktree.",
      );
    }
    return {
      strategy: {
        type: "worktree" as const,
        baseRef,
        ...(strategy.startFromOrigin === undefined
          ? {}
          : { startFromOrigin: strategy.startFromOrigin }),
      },
      taskPlan,
    };
  });

  /** Every non-deleted thread shell, active and archived. */
  const allThreads = Effect.suspend(() =>
    Effect.all([
      projections.getShellSnapshot(),
      projections.getShellSnapshot({ location: "archive" }),
    ]),
  ).pipe(
    Effect.map((snapshots) => [
      ...new Map(
        snapshots
          .flatMap((snapshot) => [...snapshot.threads, ...snapshot.archivedThreads])
          .map((thread) => [thread.id, thread] as const),
      ).values(),
    ]),
  );

  /** Paths any thread or legacy workspace record still names, even if the directory is gone. */
  const referencedPaths = Effect.gen(function* () {
    const threads = yield* allThreads;
    const legacy = yield* sql<{ readonly checkoutPath: string }>`
      SELECT checkout_path AS "checkoutPath" FROM projection_thread_workspace_roots
    `.pipe(Effect.orElseSucceed(() => []));
    return new Set([
      ...threads.flatMap((thread) =>
        thread.worktreePath === null ? [] : [NodePath.resolve(thread.worktreePath)],
      ),
      ...legacy.map((row) => NodePath.resolve(row.checkoutPath)),
    ]);
  }).pipe(
    Effect.mapError((cause) =>
      fail("ManagedWorkspaces.referencedPaths", "Could not read existing workspaces.", cause),
    ),
  );

  /** A generated title names the workspace; failures and slow models fall back to the launch title. */
  const nameSeed = Effect.fn("ManagedWorkspaces.nameSeed")(function* (
    input: CreateManagedWorkspaceInput,
  ) {
    const title = input.title.trim() === "New thread" ? "" : input.title.trim();
    const message = input.message;
    if (message === undefined) return title;
    const generated = yield* Effect.gen(function* () {
      const settings = resolveProjectSettings(
        yield* serverSettings.getSettings,
        input.projectId,
      ).settings;
      return yield* textGeneration.generateThreadTitle({
        cwd: input.projectRoot,
        message: message.text,
        attachments: message.attachments,
        modelSelection: settings.textGenerationModelSelection,
      });
    }).pipe(
      Effect.timeoutOption("5 seconds"),
      Effect.catchCause((cause) =>
        Effect.logWarning("Workspace name generation failed", { cause }).pipe(
          Effect.as(Option.none()),
        ),
      ),
    );
    const generatedTitle = Option.match(generated, {
      onNone: () => "",
      onSome: (result) => result.title.trim(),
    });
    return generatedTitle.length > 0 && generatedTitle !== "New thread" ? generatedTitle : title;
  });

  const workspaceParent = (projectRoot: string) =>
    NodePath.join(workspacesRoot, slug(NodePath.basename(projectRoot)));

  const checkCopy: ManagedWorkspaces["Service"]["checkCopy"] = Effect.fn(
    "ManagedWorkspaces.checkCopy",
  )(function* ({ projectId, projectRoot, strategy }) {
    if (strategy.type !== "worktree" && strategy.type !== "workspace") return;
    // Only a plain directory can need a copy, so no other backend asks the planner.
    const isolated = strategy.type === "workspace" && strategy.isolated === true;
    if ((yield* backendFor(projectRoot, { isolated })) !== "directory") return;
    const backend = yield* strategyBackend({ projectId, projectRoot, strategy }).pipe(
      Effect.map((launch) => launch.backend),
      // A repository choice the plan refuses fails the launch itself, with the plan's reason.
      Effect.orElseSucceed(() => "git" as const),
    );
    if (backend !== "directory") return;
    yield* checkDirectoryCopy({
      source: projectRoot,
      destinationParent: workspaceParent(projectRoot),
      baseDir: config.baseDir,
      workspacesRoot,
    });
  }, Effect.provide(context));

  const create: ManagedWorkspaces["Service"]["create"] = Effect.fn("ManagedWorkspaces.create")(
    function* (input) {
      const backend = yield* backendFor(input.projectRoot, { isolated: input.isolated });
      if (backend === "git") {
        return yield* fail("ManagedWorkspaces.create", "Git projects use worktrees.");
      }
      if (backend === "world") {
        const world = yield* worldOf(input.projectRoot);
        if (world === undefined) {
          return yield* fail(
            "ManagedWorkspaces.create",
            "This world is not configured on this server. Add it to the server's worlds settings.",
          );
        }
        // Named by the daemon's key, so a retried preparation or a resume finds the same world.
        const root = NodePath.join(input.projectRoot, worldThreadKey(input.threadId));
        yield* registerThreadWorld({
          root,
          world: world.id,
          settings: world.settings,
          threadId: input.threadId,
          projectId: input.projectId,
        });
        return { worktreePath: root, backend };
      }
      const seed = yield* nameSeed(input);
      const marker = findRepositoryMarker(input.projectRoot);
      const unavailableNames =
        backend === "jj" && marker !== null
          ? new Set((yield* listJjWorkspaces(marker.root)).map((entry) => entry.name))
          : new Set<string>();
      const worktreePath = yield* withWorkspaceReservation(
        {
          parentPath: workspaceParent(input.projectRoot),
          seed,
          fallbackSeed: fallbackWorkspaceSeed(input.threadId),
          unavailableNames,
          unavailablePaths: yield* referencedPaths,
        },
        (reservation) => {
          const created =
            backend === "jj"
              ? createJjWorkspace({
                  projectRoot: input.projectRoot,
                  destination: reservation.path,
                  name: reservation.name,
                  description: `wip: ${seed || reservation.name}`,
                  baseRef: input.baseRef,
                  startFromOrigin: input.startFromOrigin,
                })
              : backend === "isolated"
                ? createIsolatedWorkspace({
                    source: input.projectRoot,
                    destination: reservation.path,
                    projectId: input.projectId,
                    workspaceId: `workspace:${input.threadId}`,
                    profile: input.profile ?? "familiar",
                    baseRef: input.baseRef,
                    startFromOrigin: input.startFromOrigin,
                  })
                : createDirectoryCopy({
                    source: input.projectRoot,
                    destination: reservation.path,
                    baseDir: config.baseDir,
                    workspacesRoot,
                  });
          // The reservation means nobody else owns this path, so a failed or
          // cancelled creation can remove whatever it left behind.
          return created.pipe(
            Effect.onError(() =>
              deleteManaged(reservation.path, input.projectRoot).pipe(Effect.ignore),
            ),
          );
        },
      );
      return { worktreePath, backend };
    },
    Effect.provide(context),
  );

  /** The managed workspace directory that contains `path`, if any. */
  const managedRootOf = Effect.fn("ManagedWorkspaces.managedRootOf")(function* (path: string) {
    const resolved = NodePath.resolve(path);
    if (isInside(resolved, workspacesRoot) && resolved !== workspacesRoot) {
      const [project, name] = NodePath.relative(workspacesRoot, resolved).split(NodePath.sep);
      if (project !== undefined && name !== undefined) {
        return NodePath.join(workspacesRoot, project, name);
      }
    }
    const threadWorld = threadWorldOf(config.baseDir, yield* worlds, resolved);
    if (threadWorld !== undefined) return threadWorld.root;
    return yield* findIsolatedWorkspace(resolved).pipe(Effect.provide(context));
  });

  const deleteManaged = Effect.fn("ManagedWorkspaces.deleteManaged")(function* (
    root: string,
    projectRoot: string,
  ) {
    const isolatedRoot = yield* findIsolatedWorkspace(root);
    if (isolatedRoot !== null) return yield* deleteIsolatedWorkspace(isolatedRoot);
    if (!NodeFS.existsSync(root)) return;
    // Without a registration agent-exec can't ask the daemon, so only an empty one goes.
    if (isWorldProjectRoot(config.baseDir, NodePath.dirname(root))) {
      return yield* removeEmptyTree(root).pipe(
        Effect.mapError(() =>
          fail(
            "ManagedWorkspaces.delete",
            "This thread world is not registered and is not an empty folder, so its contents were kept.",
          ),
        ),
      );
    }
    if (NodeFS.statSync(NodePath.join(root, ".jj"), { throwIfNoEntry: false })?.isDirectory()) {
      return yield* deleteJjWorkspace(root);
    }
    // Workspaces from older versions include detached Git worktrees.
    if (NodeFS.statSync(NodePath.join(root, ".git"), { throwIfNoEntry: false })?.isFile()) {
      yield* git.removeWorktree({ cwd: projectRoot, path: root, force: true }).pipe(Effect.ignore);
    }
    yield* removeWorkspaceDirectory(root);
  }, Effect.provide(context));

  const discard: ManagedWorkspaces["Service"]["discard"] = Effect.fn("ManagedWorkspaces.discard")(
    function* (path) {
      const root = yield* managedRootOf(path);
      if (root === null) return;
      yield* deleteManaged(root, path);
    },
  );

  const assertUnused = Effect.fn("ManagedWorkspaces.assertUnused")(function* (root: string) {
    const threads = yield* allThreads.pipe(
      Effect.mapError((cause) =>
        fail("ManagedWorkspaces.removeWorktree", "Could not check the workspace's threads.", cause),
      ),
    );
    const inUse = threads.some(
      (thread) =>
        thread.worktreePath !== null &&
        isInside(NodePath.resolve(thread.worktreePath), root) &&
        keepsWorkspace(thread),
    );
    if (inUse) {
      return yield* fail(
        "ManagedWorkspaces.removeWorktree",
        "An active thread still uses this workspace. Settle or archive its threads before deleting it.",
      );
    }
  });

  const removeWorktree: ManagedWorkspaces["Service"]["removeWorktree"] = Effect.fn(
    "ManagedWorkspaces.removeWorktree",
  )(function* (input) {
    const root = yield* managedRootOf(input.path);
    if (root === null) return yield* git.removeWorktree(input);
    yield* assertUnused(root);
    yield* deleteManaged(root, input.cwd);
  });

  return ManagedWorkspaces.of({
    isWorldProject,
    backendFor,
    launchBackendFor,
    isIsolated,
    resolveLaunchStrategy,
    checkCopy,
    create,
    discard,
    removeWorktree,
  });
});

export const layer = Layer.effect(ManagedWorkspaces, make).pipe(Layer.provide(ProcessRunner.layer));
