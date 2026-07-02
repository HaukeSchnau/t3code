// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  ProjectId,
  ThreadId,
  ThreadWorkspace,
  ThreadWorkspaceId,
  ThreadWorkspaceRootId,
  type ThreadWorkspaceKind,
  type ThreadWorkspaceLifecycle,
  type ThreadWorkspaceRetentionPolicy,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import type {
  PrepareThreadWorkspaceInput,
  PrepareThreadWorkspaceRootInput,
} from "./ThreadWorkspaceDriver.ts";

export class ThreadWorkspaceError extends Schema.TaggedErrorClass<ThreadWorkspaceError>()(
  "ThreadWorkspaceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Thread workspace operation '${this.operation}' failed: ${this.detail}`;
  }
}

const isThreadWorkspaceError = Schema.is(ThreadWorkspaceError);

function mapWorkspaceError(operation: string) {
  return (cause: unknown) =>
    isThreadWorkspaceError(cause)
      ? cause
      : new ThreadWorkspaceError({
          operation,
          detail: "The workspace operation could not be completed.",
          cause,
        });
}

export interface PreparedThreadWorkspace {
  readonly workspace: ThreadWorkspace;
  readonly primaryCwd: string;
  readonly compatibilityWorktreePath: string | null;
  readonly compatibilityBranch: string | null;
}

interface WorkspaceRootRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly role: "primary" | "supporting";
  readonly source_path: string;
  readonly checkout_path: string;
  readonly vcs_kind: "git" | "jj" | "unknown";
  readonly repository_root: string | null;
  readonly base_revision: string | null;
  readonly head_revision: string | null;
  readonly metadata_json: string;
}

interface WorkspaceRow {
  readonly id: string;
  readonly kind: ThreadWorkspaceKind;
  readonly lifecycle: ThreadWorkspaceLifecycle;
  readonly display_name: string;
  readonly managed: 0 | 1;
  readonly primary_root_id: string;
  readonly created_for_thread_id: string | null;
  readonly retention_policy: ThreadWorkspaceRetentionPolicy;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
  readonly failure_detail: string | null;
  readonly metadata_json: string;
}

export class ThreadWorkspaceService extends Context.Service<
  ThreadWorkspaceService,
  {
    readonly prepareWorkspace: (
      input: PrepareThreadWorkspaceInput,
    ) => Effect.Effect<PreparedThreadWorkspace, ThreadWorkspaceError>;
    readonly resolvePrimaryCwd: (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly workspaceId: ThreadWorkspaceId | null;
    }) => Effect.Effect<string | undefined, ThreadWorkspaceError>;
    readonly deleteWorkspace: (input: {
      readonly workspaceId: ThreadWorkspaceId;
      readonly force?: boolean;
    }) => Effect.Effect<void, ThreadWorkspaceError>;
  }
>()("t3/workspace/ThreadWorkspaceService") {}

function nowIso(): string {
  return new Date().toISOString();
}

function slug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "workspace";
}

function shortId(value: string): string {
  return (
    slug(value)
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 12) || "workspace"
  );
}

function makeWorkspaceId(threadId: ThreadId): ThreadWorkspaceId {
  return ThreadWorkspaceId.make(`workspace:${threadId}`);
}

function makeRootId(threadId: ThreadId, index: number): ThreadWorkspaceRootId {
  return ThreadWorkspaceRootId.make(`workspace-root:${threadId}:${index}`);
}

function primaryRoot(input: PrepareThreadWorkspaceInput): PrepareThreadWorkspaceRootInput {
  const root = input.roots.find((candidate) => candidate.role === "primary") ?? input.roots[0];
  if (!root) {
    throw new ThreadWorkspaceError({
      operation: "ThreadWorkspaceService.primaryRoot",
      detail: "At least one workspace root is required.",
    });
  }
  return root;
}

function runCommand(input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}): string {
  const result = NodeChildProcess.spawnSync(input.command, input.args, {
    cwd: input.cwd,
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || `${input.command} exited with ${result.status}`);
  }
  return result.stdout.trim();
}

function runCommandResult(input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}): NodeChildProcess.SpawnSyncReturns<string> {
  return NodeChildProcess.spawnSync(input.command, input.args, {
    cwd: input.cwd,
    encoding: "utf8",
  });
}

function commandSucceeds(command: string, args: ReadonlyArray<string>, cwd: string): boolean {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "ignore",
  });
  return result.status === 0;
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function failureDetailFromCause(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return String(cause);
}

function resolveJjRevision(cwd: string, revision: string | null | undefined): string | null {
  const trimmed = revision?.trim();
  if (!trimmed) {
    return null;
  }
  const result = runCommandResult({
    command: "jj",
    args: ["log", "-r", trimmed, "--no-graph", "-T", "commit_id"],
    cwd,
  });
  if (result.error || result.status !== 0 || result.stdout.trim().length === 0) {
    return null;
  }
  return trimmed;
}

function cleanupFailedJjWorkspace(input: {
  readonly sourcePath: string;
  readonly workspaceName: string;
  readonly checkoutPath: string;
}): void {
  try {
    runCommand({
      command: "jj",
      args: ["workspace", "forget", input.workspaceName],
      cwd: input.sourcePath,
    });
  } catch {
    // TODO: Replace best-effort cleanup logging with structured workspace activity.
  }
  NodeFS.rmSync(input.checkoutPath, { recursive: true, force: true });
}

function workspaceFromRows(workspace: WorkspaceRow, roots: ReadonlyArray<WorkspaceRootRow>) {
  return ThreadWorkspace.make({
    id: ThreadWorkspaceId.make(workspace.id),
    kind: workspace.kind,
    lifecycle: workspace.lifecycle,
    displayName: workspace.display_name,
    managed: workspace.managed === 1,
    primaryRootId: ThreadWorkspaceRootId.make(workspace.primary_root_id),
    roots: roots.map((root) => ({
      id: ThreadWorkspaceRootId.make(root.id),
      workspaceId: ThreadWorkspaceId.make(root.workspace_id),
      projectId: ProjectId.make(root.project_id),
      role: root.role,
      sourcePath: root.source_path,
      checkoutPath: root.checkout_path,
      vcsKind: root.vcs_kind,
      repositoryRoot: root.repository_root,
      baseRevision: root.base_revision,
      headRevision: root.head_revision,
      metadata: parseJsonObject(root.metadata_json),
    })),
    createdForThreadId: workspace.created_for_thread_id
      ? ThreadId.make(workspace.created_for_thread_id)
      : null,
    retentionPolicy: workspace.retention_policy,
    createdAt: workspace.created_at,
    updatedAt: workspace.updated_at,
    deletedAt: workspace.deleted_at,
    failureDetail: workspace.failure_detail,
    metadata: parseJsonObject(workspace.metadata_json),
  });
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;

  const workspacesDir = NodePath.join(config.baseDir, "workspaces");

  const readWorkspace = Effect.fn("ThreadWorkspaceService.readWorkspace")(function* (
    workspaceId: ThreadWorkspaceId,
  ) {
    const workspaces = yield* sql<WorkspaceRow>`
      SELECT
        id,
        kind,
        lifecycle,
        display_name,
        managed,
        primary_root_id,
        created_for_thread_id,
        retention_policy,
        created_at,
        updated_at,
        deleted_at,
        failure_detail,
        metadata_json
      FROM projection_thread_workspaces
      WHERE id = ${workspaceId}
      LIMIT 1
    `;
    const workspace = workspaces[0];
    if (!workspace) {
      return yield* new ThreadWorkspaceError({
        operation: "ThreadWorkspaceService.readWorkspace",
        detail: `Workspace '${workspaceId}' was not found.`,
      });
    }
    const roots = yield* sql<WorkspaceRootRow>`
      SELECT
        id,
        workspace_id,
        project_id,
        role,
        source_path,
        checkout_path,
        vcs_kind,
        repository_root,
        base_revision,
        head_revision,
        metadata_json
      FROM projection_thread_workspace_roots
      WHERE workspace_id = ${workspaceId}
      ORDER BY CASE role WHEN 'primary' THEN 0 ELSE 1 END, id ASC
    `;
    return workspaceFromRows(workspace, roots);
  });

  const persistWorkspace = Effect.fn("ThreadWorkspaceService.persistWorkspace")(function* (
    workspace: ThreadWorkspace,
  ) {
    yield* sql`
      INSERT INTO projection_thread_workspaces (
        id,
        kind,
        lifecycle,
        display_name,
        managed,
        primary_root_id,
        created_for_thread_id,
        retention_policy,
        created_at,
        updated_at,
        deleted_at,
        failure_detail,
        metadata_json
      ) VALUES (
        ${workspace.id},
        ${workspace.kind},
        ${workspace.lifecycle},
        ${workspace.displayName},
        ${workspace.managed ? 1 : 0},
        ${workspace.primaryRootId},
        ${workspace.createdForThreadId},
        ${workspace.retentionPolicy},
        ${workspace.createdAt},
        ${workspace.updatedAt},
        ${workspace.deletedAt},
        ${workspace.failureDetail},
        ${JSON.stringify(workspace.metadata)}
      )
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        lifecycle = excluded.lifecycle,
        display_name = excluded.display_name,
        managed = excluded.managed,
        primary_root_id = excluded.primary_root_id,
        created_for_thread_id = excluded.created_for_thread_id,
        retention_policy = excluded.retention_policy,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at,
        failure_detail = excluded.failure_detail,
        metadata_json = excluded.metadata_json
    `;

    for (const root of workspace.roots) {
      yield* sql`
        INSERT INTO projection_thread_workspace_roots (
          id,
          workspace_id,
          project_id,
          role,
          source_path,
          checkout_path,
          vcs_kind,
          repository_root,
          base_revision,
          head_revision,
          metadata_json
        ) VALUES (
          ${root.id},
          ${root.workspaceId},
          ${root.projectId},
          ${root.role},
          ${root.sourcePath},
          ${root.checkoutPath},
          ${root.vcsKind},
          ${root.repositoryRoot ?? null},
          ${root.baseRevision ?? null},
          ${root.headRevision ?? null},
          ${JSON.stringify(root.metadata)}
        )
        ON CONFLICT(id) DO UPDATE SET
          checkout_path = excluded.checkout_path,
          base_revision = excluded.base_revision,
          head_revision = excluded.head_revision,
          metadata_json = excluded.metadata_json
      `;
    }
  });

  const makeWorkspace = (input: {
    readonly request: PrepareThreadWorkspaceInput;
    readonly kind: Exclude<ThreadWorkspaceKind, "local">;
    readonly checkoutPath: string;
    readonly vcsKind: "git" | "jj" | "unknown";
    readonly lifecycle?: ThreadWorkspaceLifecycle;
    readonly metadata?: Record<string, unknown>;
    readonly rootMetadata?: Record<string, unknown>;
    readonly headRevision?: string | null;
    readonly baseRevision?: string | null;
    readonly createdAt?: string;
    readonly updatedAt?: string;
    readonly failureDetail?: string | null;
  }) => {
    const root = primaryRoot(input.request);
    const workspaceId = makeWorkspaceId(input.request.threadId);
    const rootId = makeRootId(input.request.threadId, 0);
    const createdAt = input.createdAt ?? nowIso();
    const displayName = input.request.displayNameSeed?.trim() || NodePath.basename(root.sourcePath);
    return ThreadWorkspace.make({
      id: workspaceId,
      kind: input.kind,
      lifecycle: input.lifecycle ?? "active",
      displayName: displayName || shortId(input.request.threadId),
      managed: true,
      primaryRootId: rootId,
      roots: [
        {
          id: rootId,
          workspaceId,
          projectId: root.projectId,
          role: "primary",
          sourcePath: root.sourcePath,
          checkoutPath: input.checkoutPath,
          vcsKind: input.vcsKind,
          repositoryRoot: root.sourcePath,
          baseRevision:
            "baseRevision" in input ? (input.baseRevision ?? null) : (root.baseRevision ?? null),
          headRevision: input.headRevision ?? null,
          metadata: input.rootMetadata ?? {},
        },
      ],
      createdForThreadId: input.request.threadId,
      retentionPolicy: input.request.retentionPolicy ?? "explicit-delete",
      createdAt,
      updatedAt: input.updatedAt ?? createdAt,
      deletedAt: null,
      failureDetail: input.failureDetail ?? null,
      metadata: input.metadata ?? {},
    });
  };

  const prepareGitWorkspace = Effect.fn("ThreadWorkspaceService.prepareGitWorkspace")(function* (
    input: PrepareThreadWorkspaceInput,
  ) {
    const root = primaryRoot(input);
    let baseRevision = root.baseRevision ?? "HEAD";
    if (root.startFromOrigin && root.baseRevision) {
      yield* gitWorkflow.fetchRemote({ cwd: root.sourcePath, remoteName: "origin" });
      const resolved = yield* gitWorkflow.resolveRemoteTrackingCommit({
        cwd: root.sourcePath,
        refName: root.baseRevision,
        fallbackRemoteName: "origin",
      });
      baseRevision = resolved.commitSha;
    }

    const repoName = slug(NodePath.basename(root.sourcePath));
    const workspaceName = shortId(input.threadId);
    const checkoutPath = NodePath.join(workspacesDir, repoName, workspaceName);
    NodeFS.mkdirSync(NodePath.dirname(checkoutPath), { recursive: true });
    const worktree = yield* gitWorkflow.createWorktree({
      cwd: root.sourcePath,
      refName: baseRevision,
      detached: true,
      path: checkoutPath,
    });
    const workspace = makeWorkspace({
      request: input,
      kind: "git-detached",
      checkoutPath: worktree.worktree.path,
      vcsKind: "git",
      headRevision: baseRevision,
      metadata: { provisioner: "git-detached" },
      rootMetadata: { gitDetached: true },
    });
    yield* persistWorkspace(workspace);
    return {
      workspace,
      primaryCwd: worktree.worktree.path,
      compatibilityWorktreePath: worktree.worktree.path,
      compatibilityBranch: null,
    } satisfies PreparedThreadWorkspace;
  });

  const prepareJjWorkspace = Effect.fn("ThreadWorkspaceService.prepareJjWorkspace")(function* (
    input: PrepareThreadWorkspaceInput,
  ) {
    const root = primaryRoot(input);
    const repoName = slug(NodePath.basename(root.sourcePath));
    const workspaceName = `t3code-${shortId(input.threadId)}`;
    const checkoutPath = NodePath.join(workspacesDir, repoName, workspaceName);
    const resolvedBaseRevision = resolveJjRevision(root.sourcePath, root.baseRevision);
    NodeFS.mkdirSync(NodePath.dirname(checkoutPath), { recursive: true });
    yield* Effect.try({
      try: () => {
        const args = [
          "workspace",
          "add",
          "--name",
          workspaceName,
          "-m",
          `wip: ${input.displayNameSeed?.trim() || "t3 workspace"}`,
          ...(resolvedBaseRevision ? ["--revision", resolvedBaseRevision] : []),
          checkoutPath,
        ];
        try {
          runCommand({ command: "jj", args, cwd: root.sourcePath });
        } catch (cause) {
          cleanupFailedJjWorkspace({
            sourcePath: root.sourcePath,
            workspaceName,
            checkoutPath,
          });
          throw cause;
        }
      },
      catch: (cause) =>
        new ThreadWorkspaceError({
          operation: "ThreadWorkspaceService.prepareJjWorkspace",
          detail: "Failed to create JJ workspace.",
          cause,
        }),
    });
    const initialChangeId = yield* Effect.sync(() => {
      try {
        return runCommand({
          command: "jj",
          args: ["log", "-r", "@", "--no-graph", "-T", "change_id.short()"],
          cwd: checkoutPath,
        });
      } catch {
        return "";
      }
    });
    const workspace = makeWorkspace({
      request: input,
      kind: "jj-workspace",
      checkoutPath,
      vcsKind: "jj",
      headRevision: initialChangeId || null,
      baseRevision: resolvedBaseRevision,
      metadata: { provisioner: "jj-workspace" },
      rootMetadata: {
        jjWorkspaceName: workspaceName,
        initialChangeId,
        automaticChangePolicy: "per-turn",
        ...(root.baseRevision && root.baseRevision !== resolvedBaseRevision
          ? { requestedBaseRevision: root.baseRevision, baseRevisionSkipped: true }
          : {}),
      },
    });
    yield* persistWorkspace(workspace);
    return {
      workspace,
      primaryCwd: checkoutPath,
      compatibilityWorktreePath: checkoutPath,
      compatibilityBranch: null,
    } satisfies PreparedThreadWorkspace;
  });

  const prepareDirectoryCopyWorkspace = Effect.fn(
    "ThreadWorkspaceService.prepareDirectoryCopyWorkspace",
  )(function* (input: PrepareThreadWorkspaceInput) {
    const root = primaryRoot(input);
    const projectName = slug(NodePath.basename(root.sourcePath));
    const checkoutPath = NodePath.join(workspacesDir, projectName, shortId(input.threadId));
    const startedAt = nowIso();
    const preparingWorkspace = makeWorkspace({
      request: input,
      kind: "directory-copy",
      checkoutPath,
      vcsKind: "unknown",
      lifecycle: "preparing",
      createdAt: startedAt,
      updatedAt: startedAt,
      metadata: {
        provisioner: "directory-copy",
        preparationStatus: "preparing",
        preparationStartedAt: startedAt,
      },
    });
    yield* persistWorkspace(preparingWorkspace);
    NodeFS.mkdirSync(NodePath.dirname(checkoutPath), { recursive: true });
    const copyDirectory = Effect.try({
      try: () =>
        runCommand({
          command: "/bin/cp",
          args: ["-cR", root.sourcePath, checkoutPath],
          cwd: "/",
        }),
      catch: (cause) =>
        new ThreadWorkspaceError({
          operation: "ThreadWorkspaceService.prepareDirectoryCopyWorkspace.cp",
          detail: "Failed to copy project directory with cp.",
          cause,
        }),
    }).pipe(
      Effect.catch(() =>
        Effect.try({
          try: () => {
            NodeFS.mkdirSync(checkoutPath, { recursive: true });
            return runCommand({
              command: "rsync",
              args: ["-a", `${root.sourcePath.replace(/\/$/, "")}/`, `${checkoutPath}/`],
              cwd: "/",
            });
          },
          catch: (cause) =>
            new ThreadWorkspaceError({
              operation: "ThreadWorkspaceService.prepareDirectoryCopyWorkspace.rsync",
              detail: "Failed to copy project directory with rsync.",
              cause,
            }),
        }),
      ),
    );
    const copyExit = yield* Effect.exit(copyDirectory);
    if (Exit.isFailure(copyExit)) {
      const cause = Cause.squash(copyExit.cause);
      const failedAt = nowIso();
      yield* persistWorkspace(
        makeWorkspace({
          request: input,
          kind: "directory-copy",
          checkoutPath,
          vcsKind: "unknown",
          lifecycle: "failed",
          createdAt: startedAt,
          updatedAt: failedAt,
          failureDetail: failureDetailFromCause(cause),
          metadata: {
            provisioner: "directory-copy",
            preparationStatus: "failed",
            preparationStartedAt: startedAt,
            preparationFailedAt: failedAt,
          },
        }),
      );
      return yield* new ThreadWorkspaceError({
        operation: "ThreadWorkspaceService.prepareDirectoryCopyWorkspace",
        detail: "Failed to copy project directory.",
        cause,
      });
    }
    const completedAt = nowIso();
    const workspace = makeWorkspace({
      request: input,
      kind: "directory-copy",
      checkoutPath,
      vcsKind: "unknown",
      createdAt: startedAt,
      updatedAt: completedAt,
      metadata: {
        provisioner: "directory-copy",
        preparationStatus: "ready",
        preparationStartedAt: startedAt,
        preparationCompletedAt: completedAt,
      },
    });
    yield* persistWorkspace(workspace);
    return {
      workspace,
      primaryCwd: checkoutPath,
      compatibilityWorktreePath: checkoutPath,
      compatibilityBranch: null,
    } satisfies PreparedThreadWorkspace;
  });

  const resolveKind = (
    input: PrepareThreadWorkspaceInput,
  ): Exclude<ThreadWorkspaceKind, "local"> => {
    const root = primaryRoot(input);
    if (input.kind !== "auto") {
      return input.kind;
    }
    if (commandSucceeds("jj", ["workspace", "root"], root.sourcePath)) {
      return "jj-workspace";
    }
    if (commandSucceeds("git", ["rev-parse", "--is-inside-work-tree"], root.sourcePath)) {
      return "git-detached";
    }
    return "directory-copy";
  };

  const prepareWorkspace: ThreadWorkspaceService["Service"]["prepareWorkspace"] = Effect.fn(
    "ThreadWorkspaceService.prepareWorkspace",
  )(function* (input) {
    const mapPrepareError = Effect.mapError(
      mapWorkspaceError("ThreadWorkspaceService.prepareWorkspace"),
    );
    const kind = resolveKind(input);
    if (kind === "jj-workspace") {
      return yield* prepareJjWorkspace(input).pipe(mapPrepareError);
    }
    if (kind === "directory-copy") {
      return yield* prepareDirectoryCopyWorkspace(input).pipe(mapPrepareError);
    }
    return yield* prepareGitWorkspace(input).pipe(mapPrepareError);
  });

  const resolvePrimaryCwd: ThreadWorkspaceService["Service"]["resolvePrimaryCwd"] = Effect.fn(
    "ThreadWorkspaceService.resolvePrimaryCwd",
  )(function* (input) {
    if (!input.workspaceId) {
      return undefined;
    }
    const roots = yield* sql<{ readonly checkout_path: string }>`
      SELECT checkout_path
      FROM projection_thread_workspace_roots
      WHERE workspace_id = ${input.workspaceId}
      ORDER BY CASE role WHEN 'primary' THEN 0 ELSE 1 END, id ASC
      LIMIT 1
    `.pipe(Effect.mapError(mapWorkspaceError("ThreadWorkspaceService.resolvePrimaryCwd")));
    return roots[0]?.checkout_path;
  });

  const deleteWorkspace: ThreadWorkspaceService["Service"]["deleteWorkspace"] = Effect.fn(
    "ThreadWorkspaceService.deleteWorkspace",
  )(function* (input) {
    const workspace = yield* readWorkspace(input.workspaceId).pipe(
      Effect.mapError(mapWorkspaceError("ThreadWorkspaceService.deleteWorkspace")),
    );
    const primary = workspace.roots.find((root) => root.id === workspace.primaryRootId);
    if (!primary) {
      return yield* new ThreadWorkspaceError({
        operation: "ThreadWorkspaceService.deleteWorkspace",
        detail: `Workspace '${input.workspaceId}' has no primary root.`,
      });
    }

    if (workspace.kind === "git-detached") {
      yield* Effect.ignore(
        gitWorkflow.removeWorktree({
          cwd: primary.sourcePath,
          path: primary.checkoutPath,
          force: input.force ?? false,
        }),
      );
      NodeFS.rmSync(primary.checkoutPath, { recursive: true, force: true });
    } else if (workspace.kind === "jj-workspace") {
      const workspaceName = String(primary.metadata.jjWorkspaceName ?? "");
      if (workspaceName) {
        yield* Effect.ignore(
          Effect.try({
            try: () =>
              runCommand({
                command: "jj",
                args: ["workspace", "forget", workspaceName],
                cwd: primary.sourcePath,
              }),
            catch: mapWorkspaceError("ThreadWorkspaceService.deleteWorkspace.jjForget"),
          }),
        );
      }
      NodeFS.rmSync(primary.checkoutPath, { recursive: true, force: true });
    } else {
      NodeFS.rmSync(primary.checkoutPath, { recursive: true, force: true });
    }

    const deletedAt = nowIso();
    yield* sql`
      UPDATE projection_thread_workspaces
      SET lifecycle = 'deleted',
          deleted_at = ${deletedAt},
          updated_at = ${deletedAt}
      WHERE id = ${input.workspaceId}
    `.pipe(Effect.mapError(mapWorkspaceError("ThreadWorkspaceService.deleteWorkspace")));
  });

  return ThreadWorkspaceService.of({
    prepareWorkspace,
    resolvePrimaryCwd,
    deleteWorkspace,
  });
});

export const layer = Layer.effect(ThreadWorkspaceService, make);
