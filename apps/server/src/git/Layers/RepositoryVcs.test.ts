import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, PlatformError, Scope } from "effect";
import { expect } from "vitest";

import { GitCommandError } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { runProcess } from "../../processRunner.ts";
import { GitCoreLive } from "./GitCore.ts";
import { JjCoreLive } from "./JjCore.ts";
import { RepositoryVcsLive } from "./RepositoryVcs.ts";
import { RepositoryVcs } from "../Services/RepositoryVcs.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-repository-vcs-test-",
});
const RepositoryVcsTestLayer = RepositoryVcsLive.pipe(
  Layer.provide(
    GitCoreLive.pipe(Layer.provide(ServerConfigLayer), Layer.provide(NodeServices.layer)),
  ),
  Layer.provide(
    JjCoreLive.pipe(Layer.provide(ServerConfigLayer), Layer.provide(NodeServices.layer)),
  ),
  Layer.provide(NodeServices.layer),
);
const TestLayer = Layer.mergeAll(NodeServices.layer, RepositoryVcsTestLayer);

function makeTmpDir(
  prefix = "repository-vcs-test-",
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

function run(
  command: string,
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, GitCommandError> {
  return Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () =>
        runProcess(command, args, {
          cwd,
          allowNonZeroExit: true,
          timeoutMs: 30_000,
          maxBufferBytes: 1_000_000,
          outputMode: "error",
        }),
      catch: (cause) =>
        new GitCommandError({
          operation: "RepositoryVcs.test.run",
          command: `${command} ${args.join(" ")}`,
          cwd,
          detail: cause instanceof Error ? cause.message : "command failed.",
          cause,
        }),
    });
    const exitCode = result.code ?? (result.signal ? 1 : 0);
    if (exitCode !== 0) {
      return yield* new GitCommandError({
        operation: "RepositoryVcs.test.run",
        command: `${command} ${args.join(" ")}`,
        cwd,
        detail: result.stderr.trim() || `${command} exited with code ${exitCode}.`,
      });
    }
    return result.stdout.trim();
  });
}

const git = (cwd: string, args: ReadonlyArray<string>) => run("git", cwd, args);
const jj = (cwd: string, args: ReadonlyArray<string>) => run("jj", cwd, ["--no-pager", ...args]);

it.layer(TestLayer)("RepositoryVcs", (it) => {
  it.effect("routes colocated JJ repositories through JjCore", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const repositoryVcs = yield* RepositoryVcs;
      yield* repositoryVcs.initRepo({ cwd });
      yield* jj(cwd, ["bookmark", "set", "feature/router", "-r", "@"]);
      yield* writeTextFile(path.join(cwd, "note.txt"), "hello\n");

      const status = yield* repositoryVcs.status({ cwd });
      const branches = yield* repositoryVcs.listBranches({ cwd });

      expect(status.vcs).toBe("jj");
      expect(status.branch).toBe("feature/router");
      expect(branches.vcs).toBe("jj");
      expect(branches.branches).toContainEqual(
        expect.objectContaining({
          name: "feature/router",
          current: true,
        }),
      );
    }),
  );

  it.effect("falls back to GitCore for plain Git repositories", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* git(cwd, ["init"]);
      yield* git(cwd, ["config", "user.email", "test@example.com"]);
      yield* git(cwd, ["config", "user.name", "Test User"]);
      yield* writeTextFile(path.join(cwd, "README.md"), "# test\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "initial"]);

      const status = yield* (yield* RepositoryVcs).status({ cwd });
      const branches = yield* (yield* RepositoryVcs).listBranches({ cwd });

      expect(status.vcs).toBe("git");
      expect(branches.vcs).toBe("git");
      expect(branches.branches.some((branch) => branch.current)).toBe(true);
    }),
  );
});
