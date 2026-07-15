// @effect-diagnostics nodeBuiltinImport:off -- setup journal identities require a stable cryptographic digest.
import * as NodeCrypto from "node:crypto";

import { ProjectId } from "@t3tools/contracts";
import { projectScriptRuntimeEnv, setupProjectScript } from "@t3tools/shared/projectScripts";
import * as Encoding from "effect/Encoding";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TerminalManager from "../terminal/Manager.ts";

const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);
export const SETUP_RECONCILIATION_TIMEOUT_MILLIS = 30_000;
const SETUP_RECONCILIATION_INTERVAL_MILLIS = 100;

const SetupExecutionCompletion = Schema.Struct({
  version: Schema.Literal(1),
  executionKey: Schema.String,
  scriptDigest: Schema.String,
  exitCode: Schema.Union([Schema.Int, Schema.Null]),
  signal: Schema.Union([Schema.String, Schema.Null]),
  error: Schema.Union([Schema.String, Schema.Null]),
});
const decodeSetupExecutionCompletion = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SetupExecutionCompletion),
);

/** Quote one argument for a POSIX shell without permitting expansion or substitution. */
export const quotePosixShellArgument = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

export const setupExecutionIdentity = (
  threadId: string,
  terminalId: string,
  command: string,
): { readonly executionKey: string; readonly scriptDigest: string } => {
  const scriptDigest = NodeCrypto.createHash("sha256").update(command).digest("hex");
  return {
    executionKey: Encoding.encodeBase64Url(`${threadId}\u0000${terminalId}\u0000${scriptDigest}`),
    scriptDigest,
  };
};

export interface ProjectSetupScriptRunnerResultNoScript {
  readonly status: "no-script";
}

export interface ProjectSetupScriptRunnerResultStarted {
  readonly status: "started";
  readonly scriptId: string;
  readonly scriptName: string;
  readonly terminalId: string;
  readonly cwd: string;
}

export type ProjectSetupScriptRunnerResult =
  | ProjectSetupScriptRunnerResultNoScript
  | ProjectSetupScriptRunnerResultStarted;

export interface ProjectSetupScriptRunnerInput {
  readonly threadId: string;
  readonly projectId?: string;
  readonly projectCwd?: string;
  readonly worktreePath: string;
  readonly preferredTerminalId?: string;
  /** Reconcile a launch durably claimed by preprocessing before this process started. */
  readonly reconcileClaimedLaunch?: boolean;
}

export class ProjectSetupScriptOperationError extends Schema.TaggedErrorClass<ProjectSetupScriptOperationError>()(
  "ProjectSetupScriptOperationError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
    operation: Schema.Literals([
      "resolveProject",
      "prepareExecution",
      "openTerminal",
      "writeCommand",
      "reconcileExecution",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project setup script operation '${this.operation}' failed for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}

export class ProjectSetupScriptProjectNotFoundError extends Schema.TaggedErrorClass<ProjectSetupScriptProjectNotFoundError>()(
  "ProjectSetupScriptProjectNotFoundError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
  },
) {
  override get message(): string {
    return `Project was not found for setup script execution for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}

export class ProjectSetupScriptReconciliationTimeoutError extends Schema.TaggedErrorClass<ProjectSetupScriptReconciliationTimeoutError>()(
  "ProjectSetupScriptReconciliationTimeoutError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
    timeoutMillis: Schema.Number,
    retryable: Schema.Literal(true),
  },
) {
  override get message(): string {
    return `Setup execution '${this.terminalId}' did not publish durable completion within ${this.timeoutMillis}ms.`;
  }
}

export const ProjectSetupScriptRunnerError = Schema.Union([
  ProjectSetupScriptOperationError,
  ProjectSetupScriptProjectNotFoundError,
  ProjectSetupScriptReconciliationTimeoutError,
]);
export type ProjectSetupScriptRunnerError = typeof ProjectSetupScriptRunnerError.Type;

export class ProjectSetupScriptRunner extends Context.Service<
  ProjectSetupScriptRunner,
  {
    readonly runForThread: (
      input: ProjectSetupScriptRunnerInput,
    ) => Effect.Effect<ProjectSetupScriptRunnerResult, ProjectSetupScriptRunnerError>;
  }
>()("t3/project/ProjectSetupScriptRunner") {}

export const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { terminalLogsDir } = yield* ServerConfig.ServerConfig;

  const runForThread: ProjectSetupScriptRunner["Service"]["runForThread"] = Effect.fn(
    "ProjectSetupScriptRunner.runForThread",
  )(function* (input) {
    const errorContext = {
      threadId: input.threadId,
      worktreePath: input.worktreePath,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.projectCwd === undefined ? {} : { projectCwd: input.projectCwd }),
    };
    const executionExists = (filePath: string) =>
      fileSystem.exists(filePath).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectSetupScriptOperationError({
              ...errorContext,
              operation: "reconcileExecution",
              cause,
            }),
        ),
      );
    const projectById = input.projectId
      ? yield* projectionSnapshotQuery.getProjectShellById(ProjectId.make(input.projectId)).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.mapError(
            (cause) =>
              new ProjectSetupScriptOperationError({
                ...errorContext,
                operation: "resolveProject",
                cause,
              }),
          ),
        )
      : null;
    const project =
      projectById ??
      (input.projectCwd
        ? yield* projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(input.projectCwd).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.mapError(
              (cause) =>
                new ProjectSetupScriptOperationError({
                  ...errorContext,
                  operation: "resolveProject",
                  cause,
                }),
            ),
          )
        : null);

    if (!project) {
      return yield* new ProjectSetupScriptProjectNotFoundError(errorContext);
    }

    const script = setupProjectScript(project.scripts);
    if (!script) {
      return {
        status: "no-script",
      } as const;
    }

    const terminalId = input.preferredTerminalId ?? `setup-${script.id}`;
    const cwd = input.worktreePath;
    const env = projectScriptRuntimeEnv({
      project: { cwd: project.workspaceRoot },
      worktreePath: input.worktreePath,
    });
    const { executionKey, scriptDigest } = setupExecutionIdentity(
      input.threadId,
      terminalId,
      script.command,
    );
    const executionDir = path.join(terminalLogsDir, "setup-executions", executionKey);
    const claimDir = path.join(executionDir, "claimed");
    const completedPath = path.join(executionDir, "completed.json");
    const wrapperPath = path.join(executionDir, "run.cjs");
    const claimed = yield* executionExists(claimDir);
    const readCompletion = Effect.fn("ProjectSetupScriptRunner.readCompletion")(function* () {
      if (!(yield* executionExists(completedPath))) return Option.none();
      const encoded = yield* fileSystem.readFileString(completedPath).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectSetupScriptOperationError({
              ...errorContext,
              operation: "reconcileExecution",
              cause,
            }),
        ),
      );
      const completion = yield* decodeSetupExecutionCompletion(encoded).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectSetupScriptOperationError({
              ...errorContext,
              operation: "reconcileExecution",
              cause,
            }),
        ),
      );
      if (completion.executionKey !== executionKey || completion.scriptDigest !== scriptDigest) {
        return yield* new ProjectSetupScriptOperationError({
          ...errorContext,
          operation: "reconcileExecution",
          cause: new Error(`Setup completion journal identity mismatch for '${terminalId}'.`),
        });
      }
      return Option.some(completion);
    });
    const completed = yield* readCompletion();

    if (Option.isSome(completed)) {
      return {
        status: "started",
        scriptId: script.id,
        scriptName: script.name,
        terminalId,
        cwd,
      } as const;
    }

    const awaitJournal = <E>(
      probe: Effect.Effect<boolean, E>,
      onTimeout: () => ProjectSetupScriptReconciliationTimeoutError,
    ): Effect.Effect<void, E | ProjectSetupScriptReconciliationTimeoutError> => {
      const poll: Effect.Effect<void, E> = probe.pipe(
        Effect.flatMap((ready) =>
          ready
            ? Effect.void
            : Effect.sleep(`${SETUP_RECONCILIATION_INTERVAL_MILLIS} millis`).pipe(
                Effect.andThen(Effect.suspend(() => poll)),
              ),
        ),
      );
      return poll.pipe(
        Effect.timeoutOrElse({
          duration: `${SETUP_RECONCILIATION_TIMEOUT_MILLIS} millis`,
          orElse: () => Effect.fail(onTimeout()),
        }),
      );
    };
    const reconciliationTimeout = () =>
      new ProjectSetupScriptReconciliationTimeoutError({
        threadId: input.threadId,
        terminalId,
        timeoutMillis: SETUP_RECONCILIATION_TIMEOUT_MILLIS,
        retryable: true,
      });
    const awaitCompletion = awaitJournal(
      readCompletion().pipe(Effect.map(Option.isSome)),
      reconciliationTimeout,
    );

    if (claimed && input.reconcileClaimedLaunch) {
      yield* awaitCompletion;
      return {
        status: "started",
        scriptId: script.id,
        scriptName: script.name,
        terminalId,
        cwd,
      } as const;
    }

    const wrapper = `"use strict";\nconst fs = require("node:fs");\nconst cp = require("node:child_process");\nconst claimDir = ${encodeJson(claimDir)};\nconst completedPath = ${encodeJson(completedPath)};\nconst executionKey = ${encodeJson(executionKey)};\nconst scriptDigest = ${encodeJson(scriptDigest)};\nconst command = ${encodeJson(script.command)};\nconst cwd = ${encodeJson(cwd)};\nconst env = ${encodeJson(env)};\ntry { fs.mkdirSync(claimDir); } catch (error) { if (error && error.code === "EEXIST") process.exit(75); throw error; }\nconst result = cp.spawnSync(command, { cwd, env: { ...process.env, ...env }, shell: true, stdio: "inherit" });\nconst completion = JSON.stringify({ version: 1, executionKey, scriptDigest, exitCode: result.status, signal: result.signal, error: result.error ? String(result.error) : null }) + "\\n";\nconst temporaryPath = completedPath + "." + process.pid + ".tmp";\nfs.writeFileSync(temporaryPath, completion);\nfs.renameSync(temporaryPath, completedPath);\nprocess.exit(result.status === null ? 1 : result.status);\n`;

    yield* Effect.gen(function* () {
      yield* fileSystem.makeDirectory(executionDir, { recursive: true });
      const temporaryWrapperPath = `${wrapperPath}.tmp`;
      yield* fileSystem.writeFileString(temporaryWrapperPath, wrapper);
      yield* fileSystem.rename(temporaryWrapperPath, wrapperPath);
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectSetupScriptOperationError({
            ...errorContext,
            operation: "prepareExecution",
            cause,
          }),
      ),
    );

    yield* terminalManager
      .open({
        threadId: input.threadId,
        terminalId,
        cwd,
        worktreePath: input.worktreePath,
        env,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectSetupScriptOperationError({
              ...errorContext,
              operation: "openTerminal",
              cause,
            }),
        ),
      );
    yield* terminalManager
      .write({
        threadId: input.threadId,
        terminalId,
        data: `${quotePosixShellArgument(process.execPath)} ${quotePosixShellArgument(wrapperPath)}\r`,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectSetupScriptOperationError({
              ...errorContext,
              operation: "writeCommand",
              cause,
            }),
        ),
      );

    // A successful PTY write is not a durable launch acknowledgement. Wait until the
    // wrapper atomically claims the deterministic execution identity. A retry may
    // safely resubmit while this marker is absent; competing wrappers race on mkdir.
    yield* awaitJournal(executionExists(claimDir), reconciliationTimeout);

    // The caller may only persist `setup-completed` after this durable wrapper
    // completion exists. Waiting is interruptible, so shutdown leaves the durable
    // claim for a bounded exact-retry reconciliation.
    yield* awaitCompletion;

    return {
      status: "started",
      scriptId: script.id,
      scriptName: script.name,
      terminalId,
      cwd,
    } as const;
  });

  return ProjectSetupScriptRunner.of({ runForThread });
});

export const layer = Layer.effect(ProjectSetupScriptRunner, make);
