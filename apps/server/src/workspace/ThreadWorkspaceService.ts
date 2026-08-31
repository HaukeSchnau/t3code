// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
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
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProcessRunner from "../processRunner.ts";
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

interface DirectoryCopyPreflight {
  readonly sourceBytes: number;
  readonly maxSourceBytes: number;
  readonly availableBytes: number;
  readonly requiredAvailableBytes: number;
  readonly diskSpacePolicy: "full-copy" | "copy-on-write-guarded";
  readonly copyOnWriteSupported: boolean;
  readonly copyOnWriteKind: DirectoryCopyCopyOnWriteKind | null;
  readonly sourceDevice: number | null;
  readonly destinationDevice: number | null;
  readonly sourceFileSystemType: string | null;
  readonly destinationFileSystemType: string | null;
}

type DirectoryCopyCopyOnWriteKind = "apfs-clone" | "btrfs-reflink";

interface DirectoryCopyCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly strategy: "copy-on-write" | "recursive-copy" | "rsync";
}

interface DirectoryCopyRunResult {
  readonly initialAvailableBytes: number;
  readonly finalAvailableBytes: number;
  readonly peakConsumedBytes: number;
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
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "workspace";
}

function shortId(value: string): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

const WORKSPACE_NAME_MAX_LENGTH = 48;
const WORKSPACE_NAME_COLLISION_LIMIT = 10_000;

interface CheckoutReservation {
  readonly checkoutName: string;
  readonly checkoutPath: string;
  readonly release: () => void;
}

/**
 * Builds the human-readable portion of a workspace path. Numeric suffixes only appear when the
 * same project has already claimed the semantic name.
 */
function workspaceName(input: {
  readonly semanticSeed: string | undefined;
  readonly fallbackSeed: string;
  readonly collisionIndex?: number;
}): string {
  const collisionIndex = input.collisionIndex ?? 1;
  const suffix = collisionIndex > 1 ? `-${collisionIndex}` : "";
  const semanticLimit = WORKSPACE_NAME_MAX_LENGTH - suffix.length;
  const semanticName = slug(input.semanticSeed?.trim() || input.fallbackSeed)
    .replace(/[._]+/g, "-")
    .slice(0, semanticLimit)
    .replace(/-+$/g, "");
  return `${semanticName || "workspace"}${suffix}`;
}

function reserveCheckout(input: {
  readonly parentPath: string;
  readonly semanticSeed: string | undefined;
  readonly fallbackSeed: string;
  readonly unavailableNames?: ReadonlySet<string>;
  readonly unavailablePaths?: ReadonlySet<string>;
}): CheckoutReservation {
  NodeFS.mkdirSync(input.parentPath, { recursive: true });
  for (let collisionIndex = 1; collisionIndex <= WORKSPACE_NAME_COLLISION_LIMIT; collisionIndex++) {
    const checkoutName = workspaceName({
      semanticSeed: input.semanticSeed,
      fallbackSeed: input.fallbackSeed,
      collisionIndex,
    });
    const checkoutPath = NodePath.join(input.parentPath, checkoutName);
    if (
      input.unavailableNames?.has(checkoutName) ||
      input.unavailablePaths?.has(checkoutPath) ||
      NodeFS.existsSync(checkoutPath)
    ) {
      continue;
    }
    const reservationPath = NodePath.join(input.parentPath, `.${checkoutName}.t3-reservation`);
    try {
      NodeFS.writeFileSync(reservationPath, "", { flag: "wx" });
    } catch (cause) {
      if (
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "EEXIST"
      ) {
        continue;
      }
      throw cause;
    }
    if (NodeFS.existsSync(checkoutPath)) {
      NodeFS.rmSync(reservationPath, { force: true });
      continue;
    }
    return {
      checkoutName,
      checkoutPath,
      release: () => NodeFS.rmSync(reservationPath, { force: true }),
    };
  }
  throw new ThreadWorkspaceError({
    operation: "ThreadWorkspaceService.reserveCheckout",
    detail: `Could not allocate a workspace name below '${input.parentPath}'.`,
  });
}

function withCheckoutReservation<A, E, R>(
  input: Parameters<typeof reserveCheckout>[0],
  use: (reservation: CheckoutReservation) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ThreadWorkspaceError, R> {
  return Effect.acquireUseRelease(
    Effect.try({
      try: () => reserveCheckout(input),
      catch: mapWorkspaceError("ThreadWorkspaceService.reserveCheckout"),
    }),
    use,
    (reservation) => Effect.sync(reservation.release),
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

const DIRECTORY_COPY_MAX_BYTES_DEFAULT = 5 * 1024 * 1024 * 1024;
const DIRECTORY_COPY_MIN_FREE_BYTES = 1024 * 1024 * 1024;
const DIRECTORY_COPY_COW_MAX_TRANSIENT_BYTES = 2 * 1024 * 1024 * 1024;
const DIRECTORY_COPY_MONITOR_INTERVAL_MS = 1000;
const DIRECTORY_COPY_DU_TIMEOUT = "30 seconds";
const DIRECTORY_COPY_TIMEOUT = "20 minutes";
const DIRECTORY_COPY_TIMEOUT_MS = 20 * 60 * 1000;
const DIRECTORY_COPY_MAX_OUTPUT_BYTES = 256 * 1024;
const APFS_STATFS_TYPE = 26;
const BTRFS_STATFS_TYPE = 0x9123683e;

function directoryCopyMaxBytes(): number {
  const raw = process.env.T3CODE_DIRECTORY_COPY_MAX_BYTES;
  if (raw === undefined) {
    return DIRECTORY_COPY_MAX_BYTES_DEFAULT;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DIRECTORY_COPY_MAX_BYTES_DEFAULT;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function normalizePathForComparison(path: string, platform: NodeJS.Platform): string {
  const resolved = NodePath.resolve(path);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function realpathForPotentialPath(path: string): string {
  const resolvedPath = NodePath.resolve(path);
  const missingSegments: string[] = [];
  let existingAncestor = resolvedPath;
  while (!NodeFS.existsSync(existingAncestor)) {
    const parent = NodePath.dirname(existingAncestor);
    if (parent === existingAncestor) {
      return resolvedPath;
    }
    missingSegments.unshift(NodePath.basename(existingAncestor));
    existingAncestor = parent;
  }
  try {
    return NodePath.join(NodeFS.realpathSync.native(existingAncestor), ...missingSegments);
  } catch {
    return resolvedPath;
  }
}

function isSameOrDescendantPath(
  candidatePath: string,
  parentPath: string,
  platform: NodeJS.Platform,
): boolean {
  const candidate = normalizePathForComparison(candidatePath, platform);
  const parent = normalizePathForComparison(parentPath, platform);
  const relative = NodePath.relative(parent, candidate);
  return (
    relative === "" ||
    (relative.length > 0 && !relative.startsWith("..") && !NodePath.isAbsolute(relative))
  );
}

function safeRealpath(path: string): string {
  try {
    return NodeFS.realpathSync.native(path);
  } catch {
    return NodePath.resolve(path);
  }
}

function pathEquals(left: string, right: string, platform: NodeJS.Platform): boolean {
  return normalizePathForComparison(left, platform) === normalizePathForComparison(right, platform);
}

function sensitiveDirectoryCopyRootReason(input: {
  readonly sourcePath: string;
  readonly checkoutPath: string;
  readonly baseDir: string;
  readonly workspacesDir: string;
  readonly platform: NodeJS.Platform;
}): string | null {
  if (isSameOrDescendantPath(input.checkoutPath, input.sourcePath, input.platform)) {
    return `Directory-copy checkout '${input.checkoutPath}' would be created inside source '${input.sourcePath}'.`;
  }

  const homeDir = NodeOS.homedir();
  const sensitiveRoots = [
    NodePath.parse(input.sourcePath).root,
    homeDir,
    safeRealpath(input.baseDir),
    safeRealpath(input.workspacesDir),
    NodePath.join(homeDir, ".t3"),
    NodePath.join(homeDir, ".codex"),
    NodePath.join(homeDir, ".ssh"),
    NodePath.join(homeDir, "Library"),
  ];
  const matched = sensitiveRoots.find((sensitiveRoot) =>
    pathEquals(input.sourcePath, sensitiveRoot, input.platform),
  );
  return matched
    ? `Directory-copy workspaces cannot be created from sensitive root '${matched}'.`
    : null;
}

function availableBytesForPath(path: string): number {
  const stat = NodeFS.statfsSync(path);
  return Number(stat.bavail) * Number(stat.bsize);
}

function fullCopyRequiredAvailableBytes(sourceBytes: number): number {
  return Math.max(DIRECTORY_COPY_MIN_FREE_BYTES, Math.ceil(sourceBytes * 1.1));
}

function deviceForPath(path: string): number | null {
  try {
    return NodeFS.statSync(path).dev;
  } catch {
    return null;
  }
}

function statfsTypeForPath(path: string): number | null {
  try {
    const stat = NodeFS.statfsSync(path);
    return Number(stat.type) >>> 0;
  } catch {
    return null;
  }
}

function fileSystemTypeFromStatfsType(
  statfsType: number | null,
  platform: NodeJS.Platform,
): string | null {
  if (statfsType === null) {
    return null;
  }
  if (platform === "darwin") {
    return statfsType === APFS_STATFS_TYPE ? "apfs" : `type:${statfsType}`;
  }
  if (platform === "linux") {
    return statfsType === BTRFS_STATFS_TYPE ? "btrfs" : `type:${statfsType.toString(16)}`;
  }
  return null;
}

function fileSystemTypeForPath(path: string, platform: NodeJS.Platform): string | null {
  return fileSystemTypeFromStatfsType(statfsTypeForPath(path), platform);
}

function copyOnWriteKindForCapabilities(input: {
  readonly platform: NodeJS.Platform;
  readonly sourceDevice: number | null;
  readonly destinationDevice: number | null;
  readonly sourceFileSystemType: string | null;
  readonly destinationFileSystemType: string | null;
}): DirectoryCopyCopyOnWriteKind | null {
  if (
    input.platform === "darwin" &&
    input.sourceDevice !== null &&
    input.sourceDevice === input.destinationDevice &&
    input.sourceFileSystemType === "apfs" &&
    input.destinationFileSystemType === "apfs"
  ) {
    return "apfs-clone";
  }
  if (
    input.platform === "linux" &&
    input.sourceFileSystemType === "btrfs" &&
    input.destinationFileSystemType === "btrfs"
  ) {
    return "btrfs-reflink";
  }
  return null;
}

function directoryCopyCapabilities(input: {
  readonly sourcePath: string;
  readonly checkoutPath: string;
  readonly platform: NodeJS.Platform;
}): Pick<
  DirectoryCopyPreflight,
  | "copyOnWriteSupported"
  | "copyOnWriteKind"
  | "sourceDevice"
  | "destinationDevice"
  | "sourceFileSystemType"
  | "destinationFileSystemType"
> {
  const destinationParent = NodePath.dirname(input.checkoutPath);
  const sourceDevice = deviceForPath(input.sourcePath);
  const destinationDevice = deviceForPath(destinationParent);
  const sourceFileSystemType = fileSystemTypeForPath(input.sourcePath, input.platform);
  const destinationFileSystemType = fileSystemTypeForPath(destinationParent, input.platform);
  const copyOnWriteKind = copyOnWriteKindForCapabilities({
    platform: input.platform,
    sourceDevice,
    destinationDevice,
    sourceFileSystemType,
    destinationFileSystemType,
  });
  return {
    sourceDevice,
    destinationDevice,
    sourceFileSystemType,
    destinationFileSystemType,
    copyOnWriteKind,
    copyOnWriteSupported: copyOnWriteKind !== null,
  };
}

function primaryDirectoryCopyCommand(
  sourcePath: string,
  checkoutPath: string,
  copyOnWriteKind: DirectoryCopyCopyOnWriteKind | null,
): DirectoryCopyCommand {
  if (copyOnWriteKind === "apfs-clone") {
    return {
      command: "/bin/cp",
      args: ["-cR", sourcePath, checkoutPath],
      strategy: "copy-on-write",
    };
  }
  if (copyOnWriteKind === "btrfs-reflink") {
    return {
      command: "cp",
      args: ["-a", "--reflink=always", sourcePath, checkoutPath],
      strategy: "copy-on-write",
    };
  }
  return {
    command: "cp",
    args: ["-R", sourcePath, checkoutPath],
    strategy: "recursive-copy",
  };
}

function rsyncDirectoryCopyCommand(sourcePath: string, checkoutPath: string): DirectoryCopyCommand {
  return {
    command: "rsync",
    args: ["-a", `${sourcePath.replace(/\/$/, "")}/`, `${checkoutPath}/`],
    strategy: "rsync",
  };
}

function appendOutputChunk(current: string, chunk: Buffer): string {
  if (current.length >= DIRECTORY_COPY_MAX_OUTPUT_BYTES) {
    return current;
  }
  return (current + chunk.toString("utf8")).slice(0, DIRECTORY_COPY_MAX_OUTPUT_BYTES);
}

function runMonitoredCommand(input: {
  readonly copyCommand: DirectoryCopyCommand;
  readonly checkoutPath: string;
  readonly minimumAvailableBytes: number;
  readonly maxTransientBytes: number;
}): Promise<DirectoryCopyRunResult> {
  return new Promise((resolve, reject) => {
    const destinationParent = NodePath.dirname(input.checkoutPath);
    const initialAvailableBytes = availableBytesForPath(destinationParent);
    let peakConsumedBytes = 0;
    let stdout = "";
    let stderr = "";
    let finished = false;
    let childClosed = false;
    let monitor: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout | undefined;

    const child = NodeChildProcess.spawn(input.copyCommand.command, input.copyCommand.args, {
      cwd: "/",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const fail = (cause: Error) => {
      if (finished) {
        return;
      }
      finished = true;
      if (monitor) NodeTimers.clearInterval(monitor);
      if (timeout) NodeTimers.clearTimeout(timeout);
      if (!childClosed) {
        child.kill("SIGTERM");
        NodeTimers.setTimeout(() => {
          if (!childClosed) {
            child.kill("SIGKILL");
          }
        }, 1000).unref();
      }
      reject(cause);
    };

    monitor = NodeTimers.setInterval(() => {
      try {
        const availableBytes = availableBytesForPath(destinationParent);
        const consumedBytes = Math.max(0, initialAvailableBytes - availableBytes);
        peakConsumedBytes = Math.max(peakConsumedBytes, consumedBytes);
        if (availableBytes < input.minimumAvailableBytes) {
          fail(
            new Error(
              `Directory-copy ${input.copyCommand.strategy} stopped because available space fell below ${formatBytes(input.minimumAvailableBytes)}.`,
            ),
          );
        } else if (consumedBytes > input.maxTransientBytes) {
          fail(
            new Error(
              `Directory-copy ${input.copyCommand.strategy} stopped after consuming ${formatBytes(consumedBytes)} of transient space, exceeding the ${formatBytes(input.maxTransientBytes)} guard.`,
            ),
          );
        }
      } catch (cause) {
        fail(cause instanceof Error ? cause : new Error(String(cause)));
      }
    }, DIRECTORY_COPY_MONITOR_INTERVAL_MS);

    timeout = NodeTimers.setTimeout(() => {
      fail(
        new Error(
          `Directory-copy ${input.copyCommand.strategy} timed out after ${DIRECTORY_COPY_TIMEOUT}.`,
        ),
      );
    }, DIRECTORY_COPY_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendOutputChunk(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendOutputChunk(stderr, chunk);
    });
    child.on("error", (cause) => {
      fail(cause);
    });
    child.on("close", (code) => {
      childClosed = true;
      if (finished) {
        return;
      }
      finished = true;
      if (monitor) NodeTimers.clearInterval(monitor);
      if (timeout) NodeTimers.clearTimeout(timeout);
      const finalAvailableBytes = availableBytesForPath(destinationParent);
      peakConsumedBytes = Math.max(
        peakConsumedBytes,
        Math.max(0, initialAvailableBytes - finalAvailableBytes),
      );
      if (code !== 0) {
        reject(
          new Error(
            stderr.trim() ||
              stdout.trim() ||
              `${input.copyCommand.command} exited with ${code ?? "no exit code"}.`,
          ),
        );
        return;
      }
      resolve({
        initialAvailableBytes,
        finalAvailableBytes,
        peakConsumedBytes,
      });
    });
  });
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

function makePathUserWritable(path: string): void {
  const stack = [path];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let stat: NodeFS.Stats;
    try {
      stat = NodeFS.lstatSync(current);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      continue;
    }
    try {
      NodeFS.chmodSync(current, stat.mode | (stat.isDirectory() ? 0o700 : 0o600));
    } catch {
      // Best effort: rmSync will surface any remaining permission problem.
    }
    if (!stat.isDirectory()) {
      continue;
    }
    let entries: string[];
    try {
      entries = NodeFS.readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      stack.push(NodePath.join(current, entry));
    }
  }
}

function removeWorkspaceDirectory(path: string): void {
  try {
    NodeFS.rmSync(path, { recursive: true, force: true });
  } catch {
    makePathUserWritable(path);
    NodeFS.rmSync(path, { recursive: true, force: true });
  }
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
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const hostPlatform = yield* HostProcessPlatform;

  const workspacesDir = NodePath.join(config.baseDir, "workspaces");

  const withWorkspaceCheckout = <A, E, R>(
    input: Omit<Parameters<typeof reserveCheckout>[0], "unavailablePaths">,
    use: (reservation: CheckoutReservation) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ThreadWorkspaceError, R> =>
    sql<{ readonly checkoutPath: string }>`
      SELECT checkout_path AS "checkoutPath"
      FROM projection_thread_workspace_roots
    `.pipe(
      Effect.mapError(mapWorkspaceError("ThreadWorkspaceService.listReservedCheckoutPaths")),
      Effect.flatMap((rows) =>
        withCheckoutReservation(
          {
            ...input,
            unavailablePaths: new Set(rows.map((row) => row.checkoutPath)),
          },
          use,
        ),
      ),
    );

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

  const toPreparedWorkspace = (workspace: ThreadWorkspace): PreparedThreadWorkspace => {
    const primary = workspace.roots.find((root) => root.id === workspace.primaryRootId);
    if (!primary) {
      throw new ThreadWorkspaceError({
        operation: "ThreadWorkspaceService.toPreparedWorkspace",
        detail: `Workspace '${workspace.id}' has no primary root.`,
      });
    }
    return {
      workspace,
      primaryCwd: primary.checkoutPath,
      compatibilityWorktreePath: workspace.kind === "local" ? null : primary.checkoutPath,
      compatibilityBranch: null,
    };
  };

  const getPreparedWorkspace = Effect.fn("ThreadWorkspaceService.getPreparedWorkspace")(
    function* ({ threadId }: { readonly threadId: ThreadId }) {
      const workspaceId = makeWorkspaceId(threadId);
      const rows = yield* sql<{ readonly id: string }>`
        SELECT id
        FROM projection_thread_workspaces
        WHERE id = ${workspaceId}
          AND lifecycle = 'active'
          AND deleted_at IS NULL
        LIMIT 1
      `;
      if (!rows[0]) {
        return Option.none();
      }
      const workspace = yield* readWorkspace(workspaceId);
      return Option.some(toPreparedWorkspace(workspace));
    },
    Effect.mapError(mapWorkspaceError("ThreadWorkspaceService.getPreparedWorkspace")),
  );

  const clearIncompleteWorkspace = Effect.fn("ThreadWorkspaceService.clearIncompleteWorkspace")(
    function* (threadId: ThreadId) {
      const workspaceId = makeWorkspaceId(threadId);
      const rows = yield* sql<{ readonly id: string }>`
      SELECT id
      FROM projection_thread_workspaces
      WHERE id = ${workspaceId}
        AND lifecycle <> 'active'
      LIMIT 1
    `;
      if (!rows[0]) {
        return;
      }
      const workspace = yield* readWorkspace(workspaceId);
      const primary = workspace.roots.find((root) => root.id === workspace.primaryRootId);
      if (primary) {
        if (workspace.kind === "git-detached") {
          yield* gitWorkflow
            .removeWorktree({ cwd: primary.sourcePath, path: primary.checkoutPath, force: true })
            .pipe(Effect.ignore);
        } else if (workspace.kind === "jj-workspace") {
          const workspaceName = String(primary.metadata.jjWorkspaceName ?? "");
          if (workspaceName) {
            yield* Effect.try({
              try: () =>
                runCommand({
                  command: "jj",
                  args: ["workspace", "forget", workspaceName],
                  cwd: primary.sourcePath,
                }),
              catch: () => undefined,
            }).pipe(Effect.ignore);
          }
        }
        yield* Effect.sync(() => removeWorkspaceDirectory(primary.checkoutPath)).pipe(
          Effect.ignore,
        );
      }
      yield* sql`DELETE FROM projection_thread_workspace_roots WHERE workspace_id = ${workspaceId}`;
      yield* sql`DELETE FROM projection_thread_workspaces WHERE id = ${workspaceId}`;
    },
  );

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

  const measureDirectoryBytes = Effect.fn("ThreadWorkspaceService.measureDirectoryBytes")(
    function* (sourcePath: string) {
      const result = yield* processRunner
        .run({
          command: "du",
          args: ["-sk", sourcePath],
          cwd: "/",
          timeout: DIRECTORY_COPY_DU_TIMEOUT,
          maxOutputBytes: 1024,
          outputMode: "truncate",
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ThreadWorkspaceError({
                operation: "ThreadWorkspaceService.measureDirectoryBytes",
                detail: `Failed to measure directory size for '${sourcePath}'.`,
                cause,
              }),
          ),
        );
      if (result.code !== 0) {
        return yield* new ThreadWorkspaceError({
          operation: "ThreadWorkspaceService.measureDirectoryBytes",
          detail:
            result.stderr.trim() ||
            `du exited with ${result.code ?? "no exit code"} while measuring '${sourcePath}'.`,
        });
      }
      const kibibytes = Number.parseInt(result.stdout.trim().split(/\s+/)[0] ?? "", 10);
      if (!Number.isFinite(kibibytes)) {
        return yield* new ThreadWorkspaceError({
          operation: "ThreadWorkspaceService.measureDirectoryBytes",
          detail: `du returned an unparseable size for '${sourcePath}'.`,
        });
      }
      return kibibytes * 1024;
    },
  );

  const preflightDirectoryCopy = Effect.fn("ThreadWorkspaceService.preflightDirectoryCopy")(
    function* (input: {
      readonly sourcePath: string;
      readonly checkoutPath: string;
    }): Effect.fn.Return<DirectoryCopyPreflight, ThreadWorkspaceError> {
      const sourcePath = yield* Effect.try({
        try: () => NodeFS.realpathSync.native(input.sourcePath),
        catch: (cause) =>
          new ThreadWorkspaceError({
            operation: "ThreadWorkspaceService.preflightDirectoryCopy.realpath",
            detail: `Directory-copy source '${input.sourcePath}' could not be resolved.`,
            cause,
          }),
      });
      const sourceStat = yield* Effect.try({
        try: () => NodeFS.statSync(sourcePath),
        catch: (cause) =>
          new ThreadWorkspaceError({
            operation: "ThreadWorkspaceService.preflightDirectoryCopy.stat",
            detail: `Directory-copy source '${sourcePath}' could not be inspected.`,
            cause,
          }),
      });
      if (!sourceStat.isDirectory()) {
        return yield* new ThreadWorkspaceError({
          operation: "ThreadWorkspaceService.preflightDirectoryCopy",
          detail: `Directory-copy source '${sourcePath}' is not a directory.`,
        });
      }
      const checkoutPath = realpathForPotentialPath(input.checkoutPath);
      const unsafeRootReason = sensitiveDirectoryCopyRootReason({
        sourcePath,
        checkoutPath,
        baseDir: config.baseDir,
        workspacesDir,
        platform: hostPlatform,
      });
      if (unsafeRootReason) {
        return yield* new ThreadWorkspaceError({
          operation: "ThreadWorkspaceService.preflightDirectoryCopy",
          detail: unsafeRootReason,
        });
      }
      if (NodeFS.existsSync(input.checkoutPath)) {
        return yield* new ThreadWorkspaceError({
          operation: "ThreadWorkspaceService.preflightDirectoryCopy",
          detail: `Directory-copy checkout '${input.checkoutPath}' already exists.`,
        });
      }

      NodeFS.mkdirSync(NodePath.dirname(input.checkoutPath), { recursive: true });
      const capabilities = directoryCopyCapabilities({
        sourcePath,
        checkoutPath: input.checkoutPath,
        platform: hostPlatform,
      });
      const sourceBytes = yield* measureDirectoryBytes(sourcePath);
      const maxSourceBytes = directoryCopyMaxBytes();
      if (!capabilities.copyOnWriteSupported && sourceBytes > maxSourceBytes) {
        return yield* new ThreadWorkspaceError({
          operation: "ThreadWorkspaceService.preflightDirectoryCopy",
          detail: `Directory-copy source '${sourcePath}' is ${formatBytes(sourceBytes)}, exceeding the ${formatBytes(maxSourceBytes)} limit.`,
        });
      }

      const availableBytes = availableBytesForPath(NodePath.dirname(input.checkoutPath));
      const requiredAvailableBytes = capabilities.copyOnWriteSupported
        ? Math.max(DIRECTORY_COPY_MIN_FREE_BYTES, DIRECTORY_COPY_COW_MAX_TRANSIENT_BYTES)
        : fullCopyRequiredAvailableBytes(sourceBytes);
      if (availableBytes < requiredAvailableBytes) {
        return yield* new ThreadWorkspaceError({
          operation: "ThreadWorkspaceService.preflightDirectoryCopy",
          detail: `Directory-copy checkout '${input.checkoutPath}' needs ${formatBytes(requiredAvailableBytes)} free but only ${formatBytes(availableBytes)} is available.`,
        });
      }

      return {
        sourceBytes,
        maxSourceBytes,
        availableBytes,
        requiredAvailableBytes,
        diskSpacePolicy: capabilities.copyOnWriteSupported ? "copy-on-write-guarded" : "full-copy",
        ...capabilities,
      };
    },
  );

  const runDirectoryCopyCommand = Effect.fn("ThreadWorkspaceService.runDirectoryCopyCommand")(
    function* (input: {
      readonly copyCommand: DirectoryCopyCommand;
      readonly checkoutPath: string;
      readonly preflight: DirectoryCopyPreflight;
    }): Effect.fn.Return<DirectoryCopyRunResult, ThreadWorkspaceError> {
      if (input.preflight.copyOnWriteSupported) {
        return yield* Effect.tryPromise({
          try: () =>
            runMonitoredCommand({
              copyCommand: input.copyCommand,
              checkoutPath: input.checkoutPath,
              minimumAvailableBytes: DIRECTORY_COPY_MIN_FREE_BYTES,
              maxTransientBytes: DIRECTORY_COPY_COW_MAX_TRANSIENT_BYTES,
            }),
          catch: (cause) =>
            new ThreadWorkspaceError({
              operation: `ThreadWorkspaceService.runDirectoryCopyCommand.${input.copyCommand.strategy}`,
              detail: `Directory-copy ${input.copyCommand.strategy} process failed.`,
              cause,
            }),
        });
      }

      const result = yield* processRunner
        .run({
          command: input.copyCommand.command,
          args: input.copyCommand.args,
          cwd: "/",
          timeout: DIRECTORY_COPY_TIMEOUT,
          maxOutputBytes: DIRECTORY_COPY_MAX_OUTPUT_BYTES,
          outputMode: "truncate",
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ThreadWorkspaceError({
                operation: `ThreadWorkspaceService.runDirectoryCopyCommand.${input.copyCommand.strategy}`,
                detail: `Directory-copy ${input.copyCommand.strategy} process failed.`,
                cause,
              }),
          ),
        );
      if (result.code !== 0) {
        return yield* new ThreadWorkspaceError({
          operation: `ThreadWorkspaceService.runDirectoryCopyCommand.${input.copyCommand.strategy}`,
          detail:
            result.stderr.trim() ||
            `${input.copyCommand.command} exited with ${result.code ?? "no exit code"}.`,
        });
      }
      return {
        initialAvailableBytes: input.preflight.availableBytes,
        finalAvailableBytes: availableBytesForPath(NodePath.dirname(input.checkoutPath)),
        peakConsumedBytes: Math.max(
          0,
          input.preflight.availableBytes -
            availableBytesForPath(NodePath.dirname(input.checkoutPath)),
        ),
      };
    },
  );

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
    return yield* withWorkspaceCheckout(
      {
        parentPath: NodePath.join(workspacesDir, repoName),
        semanticSeed: input.displayNameSeed,
        fallbackSeed: repoName,
      },
      ({ checkoutPath }) =>
        Effect.gen(function* () {
          yield* persistWorkspace(
            makeWorkspace({
              request: input,
              kind: "git-detached",
              checkoutPath,
              vcsKind: "git",
              lifecycle: "preparing",
              headRevision: baseRevision,
              metadata: { provisioner: "git-detached", preparationStatus: "preparing" },
              rootMetadata: { gitDetached: true },
            }),
          );
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
        }),
    );
  });

  const prepareJjWorkspace = Effect.fn("ThreadWorkspaceService.prepareJjWorkspace")(function* (
    input: PrepareThreadWorkspaceInput,
  ) {
    const root = primaryRoot(input);
    const repoName = slug(NodePath.basename(root.sourcePath));
    const unavailableNames = yield* Effect.try({
      try: () =>
        new Set(
          runCommand({
            command: "jj",
            args: ["workspace", "list", "-T", 'self.name() ++ "\\n"'],
            cwd: root.sourcePath,
          })
            .split("\n")
            .map((name) => name.trim())
            .filter((name) => name.length > 0),
        ),
      catch: (cause) =>
        new ThreadWorkspaceError({
          operation: "ThreadWorkspaceService.prepareJjWorkspace.listWorkspaces",
          detail: "Failed to list existing JJ workspaces.",
          cause,
        }),
    });
    return yield* withWorkspaceCheckout(
      {
        parentPath: NodePath.join(workspacesDir, repoName),
        semanticSeed: input.displayNameSeed,
        fallbackSeed: repoName,
        unavailableNames,
      },
      ({ checkoutName, checkoutPath }) =>
        Effect.gen(function* () {
          const jjWorkspaceName = checkoutName;
          const resolvedBaseRevision = resolveJjRevision(root.sourcePath, root.baseRevision);
          yield* persistWorkspace(
            makeWorkspace({
              request: input,
              kind: "jj-workspace",
              checkoutPath,
              vcsKind: "jj",
              lifecycle: "preparing",
              baseRevision: resolvedBaseRevision,
              metadata: { provisioner: "jj-workspace", preparationStatus: "preparing" },
              rootMetadata: { jjWorkspaceName },
            }),
          );
          yield* Effect.try({
            try: () => {
              const args = [
                "workspace",
                "add",
                "--name",
                jjWorkspaceName,
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
                  workspaceName: jjWorkspaceName,
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
              jjWorkspaceName,
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
        }),
    );
  });

  const prepareDirectoryCopyWorkspace = Effect.fn(
    "ThreadWorkspaceService.prepareDirectoryCopyWorkspace",
  )(function* (input: PrepareThreadWorkspaceInput) {
    const root = primaryRoot(input);
    const projectName = slug(NodePath.basename(root.sourcePath));
    return yield* withWorkspaceCheckout(
      {
        parentPath: NodePath.join(workspacesDir, projectName),
        semanticSeed: input.displayNameSeed,
        fallbackSeed: projectName,
      },
      ({ checkoutPath }) =>
        Effect.gen(function* () {
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
          const preflightExit = yield* Effect.exit(
            preflightDirectoryCopy({
              sourcePath: root.sourcePath,
              checkoutPath,
            }),
          );
          if (Exit.isFailure(preflightExit)) {
            const cause = Cause.squash(preflightExit.cause);
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
              detail: failureDetailFromCause(cause),
              cause,
            });
          }

          const preflight = preflightExit.value;
          const primaryCopyCommand = primaryDirectoryCopyCommand(
            root.sourcePath,
            checkoutPath,
            preflight.copyOnWriteKind,
          );
          const copyingAt = nowIso();
          yield* persistWorkspace(
            makeWorkspace({
              request: input,
              kind: "directory-copy",
              checkoutPath,
              vcsKind: "unknown",
              lifecycle: "preparing",
              createdAt: startedAt,
              updatedAt: copyingAt,
              metadata: {
                provisioner: "directory-copy",
                preparationStatus: "copying",
                preparationStartedAt: startedAt,
                copyStartedAt: copyingAt,
                copyStrategy: primaryCopyCommand.strategy,
                diskSpacePolicy: preflight.diskSpacePolicy,
                copyOnWriteSupported: preflight.copyOnWriteSupported,
                copyOnWriteKind: preflight.copyOnWriteKind,
                sourceDevice: preflight.sourceDevice,
                destinationDevice: preflight.destinationDevice,
                sourceFileSystemType: preflight.sourceFileSystemType,
                destinationFileSystemType: preflight.destinationFileSystemType,
                maxTransientBytes: DIRECTORY_COPY_COW_MAX_TRANSIENT_BYTES,
                sourceBytes: preflight.sourceBytes,
                maxSourceBytes: preflight.maxSourceBytes,
                availableBytes: preflight.availableBytes,
                requiredAvailableBytes: preflight.requiredAvailableBytes,
              },
            }),
          );

          const copyDirectory = runDirectoryCopyCommand({
            copyCommand: primaryCopyCommand,
            checkoutPath,
            preflight,
          }).pipe(
            Effect.catch((cause) => {
              const fullCopyRequiredBytes = fullCopyRequiredAvailableBytes(preflight.sourceBytes);
              if (
                preflight.copyOnWriteSupported &&
                (preflight.sourceBytes > preflight.maxSourceBytes ||
                  preflight.availableBytes < fullCopyRequiredBytes)
              ) {
                return Effect.fail(
                  new ThreadWorkspaceError({
                    operation: "ThreadWorkspaceService.prepareDirectoryCopyWorkspace.fallback",
                    detail:
                      "Directory-copy copy-on-write failed and full-copy fallback is not safe for this source.",
                    cause,
                  }),
                );
              }
              NodeFS.mkdirSync(checkoutPath, { recursive: true });
              return runDirectoryCopyCommand({
                copyCommand: rsyncDirectoryCopyCommand(root.sourcePath, checkoutPath),
                checkoutPath,
                preflight: {
                  ...preflight,
                  copyOnWriteSupported: false,
                  diskSpacePolicy: "full-copy",
                  copyOnWriteKind: null,
                },
              });
            }),
          );
          const copyExit = yield* Effect.exit(copyDirectory);
          if (Exit.isFailure(copyExit)) {
            const cause = Cause.squash(copyExit.cause);
            const failedAt = nowIso();
            yield* Effect.sync(() => removeWorkspaceDirectory(checkoutPath)).pipe(Effect.ignore);
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
                  copyStartedAt: copyingAt,
                  preparationFailedAt: failedAt,
                  attemptedCopyStrategy: primaryCopyCommand.strategy,
                  diskSpacePolicy: preflight.diskSpacePolicy,
                  copyOnWriteSupported: preflight.copyOnWriteSupported,
                  copyOnWriteKind: preflight.copyOnWriteKind,
                  sourceDevice: preflight.sourceDevice,
                  destinationDevice: preflight.destinationDevice,
                  sourceFileSystemType: preflight.sourceFileSystemType,
                  destinationFileSystemType: preflight.destinationFileSystemType,
                  maxTransientBytes: DIRECTORY_COPY_COW_MAX_TRANSIENT_BYTES,
                  sourceBytes: preflight.sourceBytes,
                  maxSourceBytes: preflight.maxSourceBytes,
                  availableBytes: preflight.availableBytes,
                  requiredAvailableBytes: preflight.requiredAvailableBytes,
                },
              }),
            );
            return yield* new ThreadWorkspaceError({
              operation: "ThreadWorkspaceService.prepareDirectoryCopyWorkspace",
              detail: "Failed to copy project directory.",
              cause,
            });
          }
          const copyResult = copyExit.value;
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
              copyStartedAt: copyingAt,
              copyStrategy: primaryCopyCommand.strategy,
              diskSpacePolicy: preflight.diskSpacePolicy,
              copyOnWriteSupported: preflight.copyOnWriteSupported,
              copyOnWriteKind: preflight.copyOnWriteKind,
              sourceDevice: preflight.sourceDevice,
              destinationDevice: preflight.destinationDevice,
              sourceFileSystemType: preflight.sourceFileSystemType,
              destinationFileSystemType: preflight.destinationFileSystemType,
              maxTransientBytes: DIRECTORY_COPY_COW_MAX_TRANSIENT_BYTES,
              copyInitialAvailableBytes: copyResult.initialAvailableBytes,
              copyFinalAvailableBytes: copyResult.finalAvailableBytes,
              copyPeakConsumedBytes: copyResult.peakConsumedBytes,
              sourceBytes: preflight.sourceBytes,
              maxSourceBytes: preflight.maxSourceBytes,
              availableBytes: preflight.availableBytes,
              requiredAvailableBytes: preflight.requiredAvailableBytes,
            },
          });
          yield* persistWorkspace(workspace);
          return {
            workspace,
            primaryCwd: checkoutPath,
            compatibilityWorktreePath: checkoutPath,
            compatibilityBranch: null,
          } satisfies PreparedThreadWorkspace;
        }),
    );
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
    const existing = yield* getPreparedWorkspace({ threadId: input.threadId });
    if (Option.isSome(existing)) {
      return existing.value;
    }
    yield* clearIncompleteWorkspace(input.threadId).pipe(
      Effect.mapError(mapWorkspaceError("ThreadWorkspaceService.prepareWorkspace.cleanup")),
    );
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
      removeWorkspaceDirectory(primary.checkoutPath);
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
      removeWorkspaceDirectory(primary.checkoutPath);
    } else {
      removeWorkspaceDirectory(primary.checkoutPath);
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

export const __testing = {
  BTRFS_STATFS_TYPE,
  copyOnWriteKindForCapabilities,
  fileSystemTypeFromStatfsType,
  primaryDirectoryCopyCommand,
  reserveCheckout,
  workspaceName,
};
