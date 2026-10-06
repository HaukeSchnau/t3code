// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
  type VcsStatusLocalResult,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { assert, describe, it, vi } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { copyOnWriteKind, fullCopyFallbackAllowed } from "./DirectoryCopyWorkspaces.ts";
import * as ManagedWorkspaces from "./ManagedWorkspaces.ts";

const projectId = ProjectId.make("project:workspaces");
const tempDir = (prefix: string) =>
  NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix)));
const run = (command: string, args: ReadonlyArray<string>, cwd: string) =>
  NodeChildProcess.execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      JJ_USER: "T3 Test",
      JJ_EMAIL: "t3@example.com",
      GIT_AUTHOR_NAME: "T3 Test",
      GIT_AUTHOR_EMAIL: "t3@example.com",
      GIT_COMMITTER_NAME: "T3 Test",
      GIT_COMMITTER_EMAIL: "t3@example.com",
    },
  });
const jjWorkspaceNames = (repository: string) =>
  run("jj", ["--ignore-working-copy", "workspace", "list", "-T", 'name ++ "\\n"'], repository)
    .split("\n")
    .filter((name) => name.length > 0);

function jjProject(): string {
  const root = NodePath.join(tempDir("t3-jj-source-"), "studienbuch");
  NodeFS.mkdirSync(root);
  run("jj", ["git", "init", "--colocate"], root);
  NodeFS.writeFileSync(NodePath.join(root, "README.md"), "hello\n");
  run("jj", ["commit", "-m", "init"], root);
  return root;
}

function directoryProject(): string {
  const root = NodePath.join(tempDir("t3-dir-source-"), "notes");
  NodeFS.mkdirSync(NodePath.join(root, "drafts"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, "drafts", "plan.md"), "plan\n");
  return root;
}

let threadCounter = 0;
function shell(
  worktreePath: string,
  overrides: Partial<
    Pick<OrchestrationV2ThreadShell, "archivedAt" | "settledOverride" | "activityRunStatus">
  > = {},
): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make(`thread:shell-${++threadCounter}`),
    worktreePath,
    archivedAt: null,
    settledOverride: null,
    activityRunStatus: null,
    ...overrides,
  } as unknown as OrchestrationV2ThreadShell;
}

function harness(options: { readonly environment?: NodeJS.ProcessEnv } = {}) {
  const baseDir = tempDir("t3-workspaces-base-");
  const threads: Array<OrchestrationV2ThreadShell> = [];
  const removeWorktree = vi.fn(() => Effect.void);
  const localStatus = () =>
    Effect.succeed({ isRepo: true, refName: "main" } as unknown as VcsStatusLocalResult);
  const layer = ManagedWorkspaces.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), baseDir),
        Layer.mock(GitWorkflowService.GitWorkflowService)({ removeWorktree, localStatus }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getShellSnapshot: (snapshotOptions) =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads:
                snapshotOptions?.location === "archive"
                  ? []
                  : threads.filter((thread) => thread.archivedAt === null),
              archivedThreads:
                snapshotOptions?.location === "archive"
                  ? threads.filter((thread) => thread.archivedAt !== null)
                  : [],
            }),
        }),
        ServerSettings.layerTest(),
        Layer.mock(TextGeneration.TextGeneration)({
          generateThreadTitle: () => Effect.succeed({ title: "Fix login redirect" }),
        }),
        SqlitePersistenceMemory,
      ),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HostProcessPlatform, "linux"),
        Layer.succeed(HostProcessEnvironment, {
          ...process.env,
          T3CODE_EXECUTION_LAUNCHER: undefined,
          ...options.environment,
        }),
      ),
    ),
  );
  return { baseDir, threads, removeWorktree, layer };
}

const create = (projectRoot: string, threadId: string) =>
  Effect.gen(function* () {
    const workspaces = yield* ManagedWorkspaces.ManagedWorkspaces;
    return yield* workspaces.create({
      projectId,
      projectRoot,
      threadId: ThreadId.make(threadId),
      title: "Please fix the login redirect",
      message: { text: "Please fix the login redirect", attachments: [] },
    });
  });

describe("ManagedWorkspaces", () => {
  it.effect("adds jj workspaces to the project's repository instead of Git worktrees", () => {
    const test = harness();
    return Effect.gen(function* () {
      const workspaces = yield* ManagedWorkspaces.ManagedWorkspaces;
      const project = jjProject();
      assert.deepEqual(
        yield* workspaces.resolveLaunchStrategy({
          projectRoot: project,
          strategy: { type: "worktree", baseRef: "main" },
        }),
        { type: "workspace", baseRef: "main" },
      );

      const first = yield* create(project, "thread:jj-1");
      const second = yield* create(project, "thread:jj-2");
      const parent = NodePath.join(test.baseDir, "workspaces", "studienbuch");
      assert.deepEqual(first, {
        worktreePath: NodePath.join(parent, "fix-login-redirect"),
        backend: "jj",
      });
      assert.equal(second.worktreePath, NodePath.join(parent, "fix-login-redirect-2"));
      assert.equal(
        NodeFS.readFileSync(NodePath.join(first.worktreePath, "README.md"), "utf8"),
        "hello\n",
      );
      assert.includeMembers(jjWorkspaceNames(project), [
        "fix-login-redirect",
        "fix-login-redirect-2",
      ]);
      assert.isFalse(NodeFS.existsSync(NodePath.join(first.worktreePath, ".git")));

      yield* workspaces.removeWorktree({ cwd: project, path: first.worktreePath });
      yield* workspaces.discard(second.worktreePath);
      assert.isFalse(NodeFS.existsSync(first.worktreePath));
      assert.isFalse(NodeFS.existsSync(second.worktreePath));
      assert.deepEqual(jjWorkspaceNames(project), ["default"]);
      assert.equal(test.removeWorktree.mock.calls.length, 0);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("copies directory projects and refuses sensitive sources", () => {
    const test = harness();
    return Effect.gen(function* () {
      const project = directoryProject();
      const created = yield* create(project, "thread:copy");
      assert.equal(created.backend, "directory");
      assert.equal(
        NodeFS.readFileSync(NodePath.join(created.worktreePath, "drafts", "plan.md"), "utf8"),
        "plan\n",
      );

      const refused = yield* Effect.flip(create(test.baseDir, "thread:copy-base"));
      assert.equal(refused._tag, "ManagedWorkspaceError");
      assert.isFalse(
        NodeFS.existsSync(
          NodePath.join(test.baseDir, "workspaces", NodePath.basename(test.baseDir)),
        ),
      );
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("limits full copies by size; copy-on-write clones are exempt", () => {
    const test = harness({ environment: { T3CODE_DIRECTORY_COPY_MAX_BYTES: "1" } });
    return Effect.gen(function* () {
      const project = directoryProject();
      const clone = copyOnWriteKind({
        platform: "linux",
        sourceDevice: NodeFS.statSync(project).dev,
        destinationDevice: NodeFS.statSync(test.baseDir).dev,
        sourceFileSystem: Number(NodeFS.statfsSync(project).type) >>> 0,
        destinationFileSystem: Number(NodeFS.statfsSync(test.baseDir).type) >>> 0,
      });
      const result = yield* Effect.exit(create(project, "thread:copy-limit"));
      assert.equal(result._tag, clone === null ? "Failure" : "Success");
    }).pipe(Effect.provide(test.layer));
  });

  it("recognises copy-on-write filesystems and refuses unsafe full-copy fallbacks", () => {
    const btrfs = 0x9123683e;
    const facts = { sourceDevice: 1, destinationDevice: 2 };
    assert.equal(
      copyOnWriteKind({
        platform: "linux",
        ...facts,
        sourceFileSystem: btrfs,
        destinationFileSystem: btrfs,
      }),
      "btrfs-reflink",
    );
    assert.isNull(
      copyOnWriteKind({
        platform: "linux",
        ...facts,
        sourceFileSystem: 1,
        destinationFileSystem: btrfs,
      }),
    );
    assert.isNull(
      copyOnWriteKind({
        platform: "darwin",
        ...facts,
        sourceFileSystem: 26,
        destinationFileSystem: 26,
      }),
    );
    const gib = 1024 ** 3;
    assert.isFalse(
      fullCopyFallbackAllowed({
        sourceBytes: 6 * gib,
        maxSourceBytes: 5 * gib,
        availableBytes: 100 * gib,
      }),
    );
    assert.isFalse(
      fullCopyFallbackAllowed({
        sourceBytes: 3 * gib,
        maxSourceBytes: 5 * gib,
        availableBytes: 3 * gib,
      }),
    );
    assert.isTrue(
      fullCopyFallbackAllowed({
        sourceBytes: gib,
        maxSourceBytes: 5 * gib,
        availableBytes: 10 * gib,
      }),
    );
  });

  it.effect("refuses to delete a workspace an active or running thread uses", () => {
    const test = harness();
    return Effect.gen(function* () {
      const workspaces = yield* ManagedWorkspaces.ManagedWorkspaces;
      const created = yield* create(directoryProject(), "thread:guard");
      const remove = workspaces.removeWorktree({ cwd: "/unused", path: created.worktreePath });

      test.threads.push(shell(created.worktreePath));
      assert.include((yield* Effect.flip(remove)).message, "An active thread still uses");

      test.threads.splice(0, 1, shell(created.worktreePath, { settledOverride: "settled" }));
      test.threads.push(
        shell(NodePath.join(created.worktreePath, "drafts"), {
          archivedAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z"),
          activityRunStatus: "running",
        }),
      );
      assert.include((yield* Effect.flip(remove)).message, "An active thread still uses");
      assert.isTrue(NodeFS.existsSync(created.worktreePath));

      test.threads.splice(1, 1);
      yield* remove;
      assert.isFalse(NodeFS.existsSync(created.worktreePath));
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("leaves Git projects and their worktrees to upstream", () => {
    const test = harness();
    return Effect.gen(function* () {
      const workspaces = yield* ManagedWorkspaces.ManagedWorkspaces;
      const project = tempDir("t3-git-project-");
      run("git", ["init", "-q"], project);
      assert.deepEqual(
        yield* workspaces.resolveLaunchStrategy({
          projectRoot: project,
          strategy: { type: "workspace", startFromOrigin: true },
        }),
        { type: "worktree", baseRef: "main", startFromOrigin: true },
      );
      const root = { type: "root" } as const;
      assert.equal(
        yield* workspaces.resolveLaunchStrategy({ projectRoot: project, strategy: root }),
        root,
      );
      yield* workspaces.removeWorktree({ cwd: project, path: "/elsewhere/feature" });
      assert.equal(test.removeWorktree.mock.calls.length, 1);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("forks and retires isolated workspaces through the launcher", () => {
    const state = tempDir("t3-agent-exec-state-");
    const log = NodePath.join(state, "calls.log");
    const launcher = NodePath.join(state, "agent-exec");
    NodeFS.writeFileSync(
      launcher,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const recordPath = (root) => path.join(${JSON.stringify(state)}, "projects",
  crypto.createHash("sha256").update(root).digest("hex").slice(0, 20) + ".json");
if (args[0] === "fork") {
  const [, , destination] = args;
  const option = (name) => args[args.indexOf(name) + 1];
  fs.mkdirSync(destination, { recursive: true });
  const record = { version: 1, root: destination, projectId: option("--project-id"),
    workspace: { id: option("--workspace-id"), ready: true, visibleRoot: "/home/agent/" + option("--name") } };
  fs.mkdirSync(path.dirname(recordPath(destination)), { recursive: true });
  fs.writeFileSync(recordPath(destination), JSON.stringify(record));
  console.log(JSON.stringify(record));
} else if (args[0] === "retire") {
  fs.rmSync(args[1], { recursive: true, force: true });
  fs.rmSync(recordPath(args[1]), { force: true });
  console.log(JSON.stringify({ root: args[1], retained: false }));
}
`,
      { mode: 0o755 },
    );
    const test = harness({
      environment: { T3CODE_EXECUTION_LAUNCHER: launcher, AGENT_EXEC_STATE: state },
    });
    return Effect.gen(function* () {
      const workspaces = yield* ManagedWorkspaces.ManagedWorkspaces;
      const project = directoryProject();
      assert.equal(yield* workspaces.backendFor(project), "isolated");
      const created = yield* workspaces.create({
        projectId,
        projectRoot: project,
        threadId: ThreadId.make("thread:isolated"),
        title: "Draft the release notes",
        profile: "minimal",
      });
      const destination = NodePath.join(
        test.baseDir,
        "workspaces",
        "notes",
        "draft-the-release-notes",
      );
      assert.deepEqual(created, { worktreePath: destination, backend: "isolated" });

      yield* workspaces.removeWorktree({ cwd: project, path: destination });
      assert.isFalse(NodeFS.existsSync(destination));
      const calls = NodeFS.readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as ReadonlyArray<string>);
      assert.deepEqual(calls, [
        [
          "fork",
          project,
          destination,
          "--name",
          "notes",
          "--revision",
          "@",
          "--profile",
          "minimal",
          "--workspace-id",
          "workspace:thread:isolated",
          "--project-id",
          projectId,
        ],
        ["retire", destination, "--remove-checkout"],
      ]);
    }).pipe(Effect.provide(test.layer));
  });
});
