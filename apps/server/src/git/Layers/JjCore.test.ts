import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, PlatformError, Scope } from "effect";
import { describe, expect } from "vitest";

import { GitCommandError } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { runProcess } from "../../processRunner.ts";
import { JjCore } from "../Services/JjCore.ts";
import { JjCoreLive } from "./JjCore.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-jj-core-test-" });
const JjCoreTestLayer = JjCoreLive.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provide(NodeServices.layer),
);
const TestLayer = Layer.mergeAll(NodeServices.layer, JjCoreTestLayer);

function makeTmpDir(
  prefix = "jj-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function writeTextFile(
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, contents);
  });
}

function jj(cwd: string, args: ReadonlyArray<string>): Effect.Effect<string, GitCommandError> {
  return Effect.gen(function* () {
    const commandArgs = ["--no-pager", ...args];
    const result = yield* Effect.tryPromise({
      try: () =>
        runProcess("jj", commandArgs, {
          cwd,
          allowNonZeroExit: true,
          timeoutMs: 30_000,
          maxBufferBytes: 1_000_000,
          outputMode: "error",
        }),
      catch: (cause) =>
        new GitCommandError({
          operation: "JjCore.test.jj",
          command: `jj ${args.join(" ")}`,
          cwd,
          detail: cause instanceof Error ? cause.message : "jj command failed.",
          cause,
        }),
    });
    const exitCode = result.code ?? (result.signal ? 1 : 0);
    if (exitCode !== 0) {
      return yield* new GitCommandError({
        operation: "JjCore.test.jj",
        command: `jj ${args.join(" ")}`,
        cwd,
        detail: result.stderr.trim() || `jj exited with code ${exitCode}.`,
      });
    }
    return result.stdout.trim();
  });
}

function git(cwd: string, args: ReadonlyArray<string>): Effect.Effect<string, GitCommandError> {
  return Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () =>
        runProcess("git", args, {
          cwd,
          allowNonZeroExit: true,
          timeoutMs: 30_000,
          maxBufferBytes: 1_000_000,
          outputMode: "error",
        }),
      catch: (cause) =>
        new GitCommandError({
          operation: "JjCore.test.git",
          command: `git ${args.join(" ")}`,
          cwd,
          detail: cause instanceof Error ? cause.message : "git command failed.",
          cause,
        }),
    });
    const exitCode = result.code ?? (result.signal ? 1 : 0);
    if (exitCode !== 0) {
      return yield* new GitCommandError({
        operation: "JjCore.test.git",
        command: `git ${args.join(" ")}`,
        cwd,
        detail: result.stderr.trim() || `git exited with code ${exitCode}.`,
      });
    }
    return result.stdout.trim();
  });
}

function initJjRepo(cwd: string): Effect.Effect<void, GitCommandError, JjCore> {
  return Effect.gen(function* () {
    const jjCore = yield* JjCore;
    yield* jjCore.initRepo({ cwd });
    yield* jj(cwd, ["config", "set", "--repo", "user.name", "Test User"]);
    yield* jj(cwd, ["config", "set", "--repo", "user.email", "test@example.com"]);
  });
}

it.layer(TestLayer)("JjCore", (it) => {
  describe("status", () => {
    it.effect("reports a clean colocated JJ repo", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initJjRepo(cwd);

        const status = yield* (yield* JjCore).statusDetails(cwd);

        expect(status.isRepo).toBe(true);
        expect(status.vcs).toBe("jj");
        expect(status.branch).toBe(null);
        expect(status.hasWorkingTreeChanges).toBe(false);
        expect(status.workingTree.files).toEqual([]);
      }),
    );

    it.effect("reports modified files and bookmarks at the working copy change", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initJjRepo(cwd);
        yield* writeTextFile(path.join(cwd, "note.txt"), "hello\n");
        yield* jj(cwd, ["bookmark", "set", "feature/jj-status", "-r", "@"]);

        const status = yield* (yield* JjCore).statusDetails(cwd);
        const branches = yield* (yield* JjCore).listBranches({ cwd });

        expect(status.branch).toBe("feature/jj-status");
        expect(status.hasWorkingTreeChanges).toBe(true);
        expect(status.workingTree.files.map((file) => file.path)).toContain("note.txt");
        expect(branches.vcs).toBe("jj");
        expect(branches.branches).toContainEqual(
          expect.objectContaining({
            name: "feature/jj-status",
            current: true,
            isRemote: false,
          }),
        );
      }),
    );

    it.effect("keeps branch null when no bookmark points at the working copy change", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initJjRepo(cwd);
        yield* writeTextFile(path.join(cwd, "note.txt"), "hello\n");

        const status = yield* (yield* JjCore).statusDetails(cwd);

        expect(status.branch).toBe(null);
        expect(status.hasWorkingTreeChanges).toBe(true);
      }),
    );
  });

  describe("commit workflow", () => {
    it.effect("commits the working copy change and advances to a new empty change", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initJjRepo(cwd);
        yield* writeTextFile(path.join(cwd, "note.txt"), "hello\n");

        const result = yield* (yield* JjCore).commit(cwd, "add note", "");
        const committedDescription = yield* jj(cwd, [
          "log",
          "--no-graph",
          "-r",
          "@-",
          "-T",
          "description.first_line()",
        ]);
        const status = yield* (yield* JjCore).statusDetails(cwd);

        expect(result.commitSha.length).toBeGreaterThan(0);
        expect(committedDescription).toBe("add note");
        expect(status.hasWorkingTreeChanges).toBe(false);
      }),
    );

    it.effect("creates a bookmark for feature branch flows", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initJjRepo(cwd);

        const result = yield* (yield* JjCore).createBranch({
          cwd,
          branch: "feature/jj-bookmark",
        });
        const status = yield* (yield* JjCore).statusDetails(cwd);

        expect(result.branch).toBe("feature/jj-bookmark");
        expect(status.branch).toBe("feature/jj-bookmark");
      }),
    );

    it.effect("pushes a bookmark through jj git push", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("jj-test-remote-");
        yield* initJjRepo(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* jj(cwd, ["git", "remote", "add", "origin", remote]);
        yield* writeTextFile(path.join(cwd, "note.txt"), "hello\n");
        yield* jj(cwd, ["bookmark", "set", "feature/jj-push", "-r", "@"]);
        yield* (yield* JjCore).commit(cwd, "add note", "");

        const result = yield* (yield* JjCore).pushCurrentBranch(cwd, "feature/jj-push");
        const remoteHead = yield* Effect.tryPromise({
          try: () =>
            runProcess("git", ["--git-dir", remote, "rev-parse", "refs/heads/feature/jj-push"], {
              cwd,
              allowNonZeroExit: true,
              timeoutMs: 10_000,
              maxBufferBytes: 1_000_000,
              outputMode: "error",
            }),
          catch: (cause) =>
            new GitCommandError({
              operation: "JjCore.test.git",
              command: "git rev-parse refs/heads/feature/jj-push",
              cwd,
              detail: cause instanceof Error ? cause.message : "git command failed.",
              cause,
            }),
        });

        expect(result).toMatchObject({
          status: "pushed",
          branch: "feature/jj-push",
          upstreamBranch: "origin/feature/jj-push",
        });
        expect(remoteHead.code).toBe(0);
        expect(remoteHead.stdout.trim().length).toBeGreaterThan(0);
      }),
    );
  });

  describe("commit graph", () => {
    it.effect("loads current JJ history with current change metadata", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initJjRepo(cwd);
        yield* writeTextFile(path.join(cwd, "note.txt"), "hello\n");
        yield* (yield* JjCore).commit(cwd, "add note", "");
        yield* jj(cwd, ["bookmark", "set", "feature/graph", "-r", "@-"]);

        const graph = yield* (yield* JjCore).commitGraph({ cwd, limit: 10 });

        expect(graph.vcs).toBe("jj");
        expect(graph.supported).toBe(true);
        expect(graph.currentOperationId?.length).toBeGreaterThan(0);
        expect(graph.nodes.some((node) => node.currentWorkingCopy)).toBe(true);
        expect(graph.nodes).toContainEqual(
          expect.objectContaining({
            description: "add note",
            localBookmarks: expect.arrayContaining(["feature/graph"]),
          }),
        );
        expect(graph.edges.length).toBeGreaterThan(0);
      }),
    );

    it.effect("sets hasMore when graph results exceed the requested limit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initJjRepo(cwd);
        yield* writeTextFile(path.join(cwd, "one.txt"), "one\n");
        yield* (yield* JjCore).commit(cwd, "one", "");
        yield* writeTextFile(path.join(cwd, "two.txt"), "two\n");
        yield* (yield* JjCore).commit(cwd, "two", "");

        const graph = yield* (yield* JjCore).commitGraph({ cwd, limit: 1 });

        expect(graph.nodes).toHaveLength(1);
        expect(graph.hasMore).toBe(true);
      }),
    );

    it.effect("loads change details for selected JJ graph nodes", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initJjRepo(cwd);
        yield* writeTextFile(path.join(cwd, "details.txt"), "hello\n");
        yield* (yield* JjCore).commit(cwd, "details", "");

        const graph = yield* (yield* JjCore).commitGraph({ cwd, limit: 10 });
        const detailsNode = graph.nodes.find((node) => node.description === "details")!;
        const details = yield* (yield* JjCore).commitGraphChangeDetails({
          cwd,
          changeId: detailsNode.changeId,
        });

        expect(details.node.description).toBe("details");
        expect(details.changedFilesSummary).toContain("details.txt");
        expect(details.diffStat).toContain("details.txt");
        expect(details.diffPreview).toContain("details.txt");
      }),
    );

    it.effect("rejects stale graph actions and applies describe/bookmark actions", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initJjRepo(cwd);
        const jjCore = yield* JjCore;
        const graph = yield* jjCore.commitGraph({ cwd, limit: 10 });

        const staleError = yield* Effect.flip(
          jjCore.runCommitGraphAction({
            cwd,
            expectedOperationId: "stale",
            action: { kind: "describe", changeId: graph.nodes[0]!.changeId, message: "updated" },
          }),
        );
        expect(staleError.detail).toMatch(/changed since this graph was loaded/i);

        yield* jjCore.runCommitGraphAction({
          cwd,
          expectedOperationId: graph.currentOperationId!,
          action: { kind: "describe", changeId: graph.nodes[0]!.changeId, message: "updated" },
        });
        const afterDescribe = yield* jjCore.commitGraph({ cwd, limit: 10 });
        yield* jjCore.runCommitGraphAction({
          cwd,
          expectedOperationId: afterDescribe.currentOperationId!,
          action: {
            kind: "bookmark_set",
            name: "feature/from-graph",
            changeId: graph.nodes[0]!.changeId,
          },
        });
        const afterBookmark = yield* jjCore.commitGraph({ cwd, limit: 10 });

        expect(afterDescribe.nodes[0]?.description).toBe("updated");
        expect(afterBookmark.nodes[0]?.localBookmarks).toContain("feature/from-graph");
      }),
    );
  });
});
