import * as NodeCrypto from "node:crypto";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { type OrchestrationProject, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Duration from "effect/Duration";

import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

const isProjectSetupScriptOperationError = Schema.is(
  ProjectSetupScriptRunner.ProjectSetupScriptOperationError,
);
const isProjectSetupScriptReconciliationTimeoutError = Schema.is(
  ProjectSetupScriptRunner.ProjectSetupScriptReconciliationTimeoutError,
);
const encodeTestJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodePosixShellArgument = (literal: string): string => {
  if (!literal.startsWith("'") || !literal.endsWith("'")) {
    throw new Error(`Invalid POSIX shell argument: ${literal}`);
  }
  return literal.slice(1, -1).replaceAll(`'\\''`, "'");
};

const wrapperPathFromWrite = (data: string): string => {
  const boundary = data.trim().indexOf("' '");
  if (boundary < 0) throw new Error(`Missing wrapper path in terminal write: ${data}`);
  return decodePosixShellArgument(data.trim().slice(boundary + 2));
};

const validCompletion = (
  threadId = "thread-1",
  terminalId = "setup-setup",
  command = "bun install",
) => {
  const identity = ProjectSetupScriptRunner.setupExecutionIdentity(threadId, terminalId, command);
  return encodeTestJson({
    version: 1,
    ...identity,
    exitCode: 0,
    signal: null,
    error: null,
  });
};

const makeProject = (scripts: OrchestrationProject["scripts"]): OrchestrationProject => ({
  id: ProjectId.make("project-1"),
  title: "Project",
  workspaceRoot: "/repo/project",
  defaultModelSelection: null,
  scripts,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
});

const makeProjectionSnapshotQueryLayer = (project: OrchestrationProject) =>
  Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
    getUserInputActivity: () => Effect.die("unused"),
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
    getCounts: () => Effect.die("unused"),
    getEventReplayStats: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: (workspaceRoot) =>
      Effect.succeed(
        workspaceRoot === project.workspaceRoot ? Option.some(project) : Option.none(),
      ),
    getProjectShellById: (projectId) =>
      Effect.succeed(projectId === project.id ? Option.some(project) : Option.none()),
    getImportedAgentSessionSources: () => Effect.die("unused"),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadRuntimeContext: () => Effect.die("unused"),
    getTurnStartMessage: () => Effect.die("unused"),
    getThreadShellById: () => Effect.die("unused"),
    getThreadResultContextById: () => Effect.die("unused"),
    listThreadRelationshipActivities: () => Effect.die("unused"),
    getThreadDetailById: () => Effect.die("unused"),
    getThreadDetailSnapshot: () => Effect.die("unused"),
    getTurnActivitiesSnapshot: () => Effect.die("unused"),
    searchThreads: () => Effect.succeed({ matches: [] }),
  });

const makeTerminalManagerLayer = (
  overrides: Pick<TerminalManager.TerminalManager["Service"], "open" | "write">,
) =>
  Layer.succeed(TerminalManager.TerminalManager, {
    ...overrides,
    attachStream: () => Effect.die(new Error("unused")),
    resize: () => Effect.void,
    clear: () => Effect.void,
    restart: () => Effect.die(new Error("unused")),
    close: () => Effect.void,
    subscribe: () => Effect.succeed(() => undefined),
    subscribeMetadata: () => Effect.succeed(() => undefined),
  });

const testLayer = (
  project: OrchestrationProject,
  terminal: Pick<TerminalManager.TerminalManager["Service"], "open" | "write">,
  onCompletionCheck: Effect.Effect<void> = Effect.void,
) => {
  const observedFileSystem = Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      return {
        ...fileSystem,
        exists: (filePath: string) =>
          fileSystem
            .exists(filePath)
            .pipe(
              Effect.tap(() =>
                filePath.endsWith("completed.json") ? onCompletionCheck : Effect.void,
              ),
            ),
      };
    }),
  ).pipe(Layer.provide(NodeFileSystem.layer));
  const nodeFileServices = Layer.merge(observedFileSystem, NodePath.layer);
  return Layer.mergeAll(
    ProjectSetupScriptRunner.layer.pipe(
      Layer.provideMerge(makeProjectionSnapshotQueryLayer(project)),
      Layer.provideMerge(makeTerminalManagerLayer(terminal)),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-setup-runner-test-" }).pipe(
          Layer.provide(nodeFileServices),
        ),
      ),
      Layer.provide(nodeFileServices),
    ),
    nodeFileServices,
  );
};

const claimWrapperExecution = (data: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const wrapperPath = wrapperPathFromWrite(data);
    const executionDirectory = path.dirname(wrapperPath);
    yield* fileSystem.makeDirectory(path.join(executionDirectory, "claimed"));
    yield* fileSystem.writeFileString(
      path.join(executionDirectory, "completed.json"),
      validCompletion(),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.orDie);

describe("ProjectSetupScriptRunner", () => {
  it.effect("returns no-script when no setup script exists", () => {
    const open = vi.fn(() => Effect.die("unexpected open"));
    const write = vi.fn(() => Effect.die("unexpected write"));
    const project = makeProject([]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
      });

      expect(result).toEqual({ status: "no-script" });
      expect(open).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    }).pipe(Effect.provide(testLayer(project, { open, write })));
  });

  it.effect("rejects a changed live setup identity before terminal I/O", () => {
    const open = vi.fn(() => Effect.die("unexpected open"));
    const write = vi.fn(() => Effect.die("unexpected write"));
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install --changed",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner
        .runForThread({
          threadId: "thread-1",
          projectId: "project-1",
          worktreePath: "/repo/worktrees/a",
          preferredTerminalId: "setup-setup",
          reconcileClaimedLaunch: true,
          expectedExecution: ProjectSetupScriptRunner.setupExecutionIdentity(
            "thread-1",
            "setup-setup",
            "bun install --original",
          ),
        })
        .pipe(Effect.result);

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("ProjectSetupScriptIdentityMismatchError");
      }
      expect(open).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    }).pipe(Effect.provide(testLayer(project, { open, write })));
  });

  it.effect(
    "opens the deterministic setup terminal with worktree env and writes the command",
    () => {
      const open = vi.fn(() =>
        Effect.succeed({
          threadId: "thread-1",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
          worktreePath: "/repo/worktrees/a",
          status: "running" as const,
          pid: 123,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "setup-setup",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      const write = vi.fn(
        (input: Parameters<TerminalManager.TerminalManager["Service"]["write"]>[0]) =>
          claimWrapperExecution(input.data),
      );
      const project = makeProject([
        {
          id: "setup",
          name: "Setup",
          command: "bun install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]);

      return Effect.gen(function* () {
        const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
        const result = yield* runner.runForThread({
          threadId: "thread-1",
          projectCwd: "/repo/project",
          worktreePath: "/repo/worktrees/a",
        });

        expect(result).toEqual({
          status: "started",
          scriptId: "setup",
          scriptName: "Setup",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
        });
        expect(open).toHaveBeenCalledWith({
          threadId: "thread-1",
          terminalId: "setup-setup",
          cwd: "/repo/worktrees/a",
          worktreePath: "/repo/worktrees/a",
          env: {
            T3CODE_PROJECT_ROOT: "/repo/project",
            T3CODE_WORKTREE_PATH: "/repo/worktrees/a",
          },
        });
        expect(write).toHaveBeenCalledOnce();
        expect(write.mock.calls[0]?.[0].threadId).toBe("thread-1");
        expect(write.mock.calls[0]?.[0].terminalId).toBe("setup-setup");
        expect(write.mock.calls[0]?.[0].data).toContain("run.cjs");
      }).pipe(Effect.provide(testLayer(project, { open, write })));
    },
  );

  it.effect("runs and reconciles a setup wrapper through the workspace's private home", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const base = yield* fileSystem.makeTempDirectoryScoped();
      const state = path.join(base, "registry");
      const actualRoot = path.join(base, "host-workspace");
      const root = path.join(base, "workspace-link");
      const visibleRoot = path.join(base, "visible-workspace");
      const visibleHome = path.join(base, "visible-home");
      yield* fileSystem.makeDirectory(actualRoot);
      yield* fileSystem.symlink(actualRoot, root);
      yield* fileSystem.makeDirectory(visibleRoot);
      const canonicalRoot = yield* fileSystem.realPath(root);
      const id = NodeCrypto.createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 20);
      const privateHome = path.join(state, "environments", id, "home");
      yield* fileSystem.makeDirectory(privateHome, { recursive: true });
      // Represent the runtime's home mount with a symlink; all wrapper I/O is real.
      yield* fileSystem.symlink(privateHome, visibleHome);
      yield* fileSystem.makeDirectory(path.join(state, "projects"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(state, "projects", `${id}.json`),
        encodeTestJson({ root: canonicalRoot, home: visibleHome, workspace: { visibleRoot } }),
      );
      const script = `${ProjectSetupScriptRunner.quotePosixShellArgument(process.execPath)} -e 'require("node:fs").appendFileSync("setup-runs.txt", process.env.T3CODE_WORKTREE_PATH + "\\n")'`;
      const project = makeProject([
        {
          id: "setup",
          name: "Setup",
          command: script,
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]);
      const open = vi.fn(() =>
        Effect.succeed({
          threadId: "thread-1",
          terminalId: "setup-setup",
          cwd: root,
          worktreePath: root,
          status: "running" as const,
          pid: 123,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "setup",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      const write = vi.fn(
        (input: Parameters<TerminalManager.TerminalManager["Service"]["write"]>[0]) =>
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make(process.execPath, [wrapperPathFromWrite(input.data)]),
            );
            const [exitCode, output] = yield* Effect.all(
              [handle.exitCode, handle.all.pipe(Stream.decodeText, Stream.mkString)],
              { concurrency: "unbounded" },
            );
            expect(exitCode, output).toBe(0);
          }).pipe(Effect.scoped, Effect.orDie),
      );
      yield* Effect.gen(function* () {
        const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
        const input = { threadId: "thread-1", projectId: "project-1", worktreePath: root };
        expect((yield* runner.runForThread(input)).status).toBe("started");
        expect(
          (yield* runner.runForThread({ ...input, reconcileClaimedLaunch: true })).status,
        ).toBe("started");
        expect(write).toHaveBeenCalledOnce();
        expect(yield* fileSystem.readFileString(path.join(visibleRoot, "setup-runs.txt"))).toBe(
          `${visibleRoot}\n`,
        );
        expect(yield* fileSystem.exists(path.join(root, "setup-runs.txt"))).toBe(false);
        const identity = ProjectSetupScriptRunner.setupExecutionIdentity(
          "thread-1",
          "setup-setup",
          script,
        );
        const completion = yield* fileSystem.readFileString(
          path.join(
            privateHome,
            ".local/state/t3/setup-executions",
            identity.executionKey,
            "completed.json",
          ),
        );
        expect(completion).toContain('"exitCode":0');
      }).pipe(
        Effect.provide(testLayer(project, { open, write })),
        Effect.provideService(HostProcessEnvironment, { AGENT_EXEC_STATE: state }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reconciles an interrupted claimed execution before exact retry completes", () => {
    let wrapperPath = "";
    let claimed!: Deferred.Deferred<void>;
    let completionChecked!: Deferred.Deferred<void>;
    let completionChecks = 0;
    const onCompletionCheck = Effect.suspend(() =>
      ++completionChecks === 2
        ? Deferred.succeed(completionChecked, undefined).pipe(Effect.asVoid)
        : Effect.void,
    );
    const open = vi.fn(() =>
      Effect.succeed({
        threadId: "thread-1",
        terminalId: "setup-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "setup-setup",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const write = vi.fn(
      (input: Parameters<TerminalManager.TerminalManager["Service"]["write"]>[0]) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          wrapperPath = wrapperPathFromWrite(input.data);
          yield* fileSystem.makeDirectory(path.join(path.dirname(wrapperPath), "claimed"));
          yield* Deferred.succeed(claimed, undefined);
        }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
    );
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      claimed = yield* Deferred.make<void>();
      completionChecked = yield* Deferred.make<void>();
      const input = {
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
        preferredTerminalId: "setup-setup",
      };
      const interrupted = yield* runner.runForThread(input).pipe(Effect.forkChild);
      yield* Deferred.await(claimed);
      // The first check reads prior completion; the second follows launch acknowledgement.
      yield* Deferred.await(completionChecked);
      yield* TestClock.adjust(Duration.minutes(2));
      expect(interrupted.pollUnsafe()).toBeUndefined();
      yield* Fiber.interrupt(interrupted);
      expect(open).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledOnce();

      completionChecks = 0;
      completionChecked = yield* Deferred.make<void>();
      const retry = yield* runner
        .runForThread({ ...input, reconcileClaimedLaunch: true })
        .pipe(Effect.forkChild);
      yield* Deferred.await(completionChecked);
      yield* TestClock.adjust(Duration.minutes(2));
      expect(retry.pollUnsafe()).toBeUndefined();
      expect(open).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledOnce();
      yield* fileSystem.writeFileString(
        path.join(path.dirname(wrapperPath), "completed.json"),
        validCompletion(),
      );
      yield* TestClock.adjust(Duration.millis(100));
      const completed = yield* Fiber.join(retry);
      expect(completed.status).toBe("started");
      expect(open).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(testLayer(project, { open, write }, onCompletionCheck)));
  });

  it.effect("rejects malformed and mismatched completion journals", () => {
    let wrapperPath = "";
    let claimed!: Deferred.Deferred<void>;
    const open = vi.fn(() =>
      Effect.succeed({
        threadId: "thread-1",
        terminalId: "setup-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "setup-setup",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const write = vi.fn(
      (input: Parameters<TerminalManager.TerminalManager["Service"]["write"]>[0]) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          wrapperPath = wrapperPathFromWrite(input.data);
          yield* fileSystem.makeDirectory(path.join(path.dirname(wrapperPath), "claimed"));
          yield* Deferred.succeed(claimed, undefined);
        }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
    );
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      claimed = yield* Deferred.make<void>();
      const input = {
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
        preferredTerminalId: "setup-setup",
      };
      const first = yield* runner.runForThread(input).pipe(Effect.forkChild);
      yield* Deferred.await(claimed);
      yield* Fiber.interrupt(first);
      const completionPath = path.join(path.dirname(wrapperPath), "completed.json");

      yield* fileSystem.writeFileString(completionPath, "not-json");
      const malformed = yield* runner
        .runForThread({ ...input, reconcileClaimedLaunch: true })
        .pipe(Effect.flip);
      expect(isProjectSetupScriptOperationError(malformed)).toBe(true);

      yield* fileSystem.writeFileString(
        completionPath,
        encodeTestJson({
          version: 1,
          executionKey: "stale-execution",
          scriptDigest: "stale-script",
          exitCode: 0,
          signal: null,
          error: null,
        }),
      );
      const mismatched = yield* runner
        .runForThread({ ...input, reconcileClaimedLaunch: true })
        .pipe(Effect.flip);
      expect(isProjectSetupScriptOperationError(mismatched)).toBe(true);
      if (isProjectSetupScriptOperationError(mismatched)) {
        expect(String(mismatched.cause)).toContain("identity mismatch");
      }
    }).pipe(Effect.provide(testLayer(project, { open, write })));
  });

  it.effect("bounds claimed setup completion with a typed, retryable timeout", () => {
    let claimed!: Deferred.Deferred<void>;
    let completionChecked!: Deferred.Deferred<void>;
    let completionChecks = 0;
    const onCompletionCheck = Effect.suspend(() =>
      ++completionChecks === 2
        ? Deferred.succeed(completionChecked, undefined).pipe(Effect.asVoid)
        : Effect.void,
    );
    const open = vi.fn(() => Effect.succeed({} as never));
    const write = vi.fn(
      (input: Parameters<TerminalManager.TerminalManager["Service"]["write"]>[0]) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const wrapperPath = wrapperPathFromWrite(input.data);
          yield* fileSystem.makeDirectory(path.join(path.dirname(wrapperPath), "claimed"));
          yield* Deferred.succeed(claimed, undefined);
        }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
    );
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    return Effect.gen(function* () {
      claimed = yield* Deferred.make<void>();
      completionChecked = yield* Deferred.make<void>();
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const running = yield* runner
        .runForThread({
          threadId: "thread-1",
          projectId: "project-1",
          worktreePath: "/repo/worktrees/a",
          preferredTerminalId: "setup-setup",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(claimed);
      yield* Deferred.await(completionChecked);
      yield* TestClock.adjust(
        Duration.millis(ProjectSetupScriptRunner.SETUP_COMPLETION_TIMEOUT_MILLIS),
      );
      const timeout = yield* Fiber.join(running).pipe(Effect.flip);
      expect(isProjectSetupScriptReconciliationTimeoutError(timeout)).toBe(true);
      if (isProjectSetupScriptReconciliationTimeoutError(timeout)) {
        expect(timeout.retryable).toBe(true);
        expect(timeout.timeoutMillis).toBe(15 * 60_000);
      }
    }).pipe(Effect.provide(testLayer(project, { open, write }, onCompletionCheck)));
  });

  it.effect("still detects an unclaimed launch after 30 seconds", () => {
    let written!: Deferred.Deferred<void>;
    const open = vi.fn(() => Effect.succeed({} as never));
    const write = vi.fn(() => Deferred.succeed(written, undefined).pipe(Effect.asVoid));
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "pnpm install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);
    return Effect.gen(function* () {
      written = yield* Deferred.make<void>();
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const running = yield* runner
        .runForThread({
          threadId: "thread-1",
          projectId: "project-1",
          worktreePath: "/repo/worktrees/a",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(written);
      yield* TestClock.adjust(
        Duration.millis(ProjectSetupScriptRunner.SETUP_LAUNCH_TIMEOUT_MILLIS),
      );
      const timeout = yield* Fiber.join(running).pipe(Effect.flip);
      expect(isProjectSetupScriptReconciliationTimeoutError(timeout)).toBe(true);
      if (isProjectSetupScriptReconciliationTimeoutError(timeout)) {
        expect(timeout.retryable).toBe(true);
        expect(timeout.timeoutMillis).toBe(30_000);
      }
    }).pipe(Effect.provide(testLayer(project, { open, write })));
  });

  it("quotes executable and wrapper paths as inert POSIX shell arguments", () => {
    const values = [
      "/tmp/with spaces/node",
      "/tmp/$(touch injected)/node",
      "/tmp/`touch injected`/node",
      "/tmp/$HOME/node",
      "/tmp/Hauke's node",
      "/tmp/all $(bad) `bad` $PATH and Hauke's node",
    ];

    for (const value of values) {
      const quoted = ProjectSetupScriptRunner.quotePosixShellArgument(value);
      expect(decodePosixShellArgument(quoted)).toBe(value);
      expect(quoted.startsWith("'")).toBe(true);
      expect(quoted.endsWith("'")).toBe(true);
    }
  });

  it.effect("safely resubmits when terminal open completed without an execution claim", () => {
    const open = vi.fn(() =>
      Effect.succeed({
        threadId: "thread-1",
        terminalId: "setup-setup",
        cwd: "/repo/worktrees/a",
        worktreePath: "/repo/worktrees/a",
        status: "running" as const,
        pid: 123,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "setup-setup",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    let writeAttempt = 0;
    const write = vi.fn(
      (input: Parameters<TerminalManager.TerminalManager["Service"]["write"]>[0]) => {
        writeAttempt += 1;
        return writeAttempt === 1
          ? Effect.fail(
              new TerminalManager.TerminalNotRunningError({
                threadId: input.threadId,
                terminalId: input.terminalId,
              }),
            )
          : claimWrapperExecution(input.data);
      },
    );
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const input = {
        threadId: "thread-1",
        projectId: "project-1",
        worktreePath: "/repo/worktrees/a",
        preferredTerminalId: "setup-setup",
      };
      const interrupted = yield* runner.runForThread(input).pipe(Effect.flip);
      expect(isProjectSetupScriptOperationError(interrupted)).toBe(true);
      if (isProjectSetupScriptOperationError(interrupted)) {
        expect(interrupted.operation).toBe("writeCommand");
      }

      const resumed = yield* runner.runForThread({
        ...input,
        reconcileClaimedLaunch: true,
      });
      expect(resumed.status).toBe("started");
      expect(open).toHaveBeenCalledTimes(2);
      expect(write).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(testLayer(project, { open, write })));
  });

  it.effect("keeps terminal failures as the exact cause of a structured operation error", () => {
    const rootCause = new Error("stat failed");
    const terminalError = new TerminalManager.TerminalCwdStatError({
      cwd: "/repo/worktrees/a",
      cause: rootCause,
    });
    const project = makeProject([
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ]);

    return Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const error = yield* runner
        .runForThread({
          threadId: "thread-1",
          projectId: "project-1",
          worktreePath: "/repo/worktrees/a",
        })
        .pipe(Effect.flip);

      expect(isProjectSetupScriptOperationError(error)).toBe(true);
      if (isProjectSetupScriptOperationError(error)) {
        expect(error.operation).toBe("openTerminal");
        expect(error.threadId).toBe("thread-1");
        expect(error.projectId).toBe("project-1");
        expect(error.worktreePath).toBe("/repo/worktrees/a");
        expect(error.cause).toBe(terminalError);
        expect(terminalError.cause).toBe(rootCause);
      }
    }).pipe(
      Effect.provide(
        testLayer(project, {
          open: () => Effect.fail(terminalError),
          write: () => Effect.die("unexpected write"),
        }),
      ),
    );
  });
});
