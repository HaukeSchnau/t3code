import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ThreadId } from "@t3tools/contracts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as JjCli from "../vcs/JjCli.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as JjThreadWork from "./JjThreadWork.ts";

const roots = { projects: [] as Array<string>, threads: [] as Array<string> };

const TestLayer = JjThreadWork.layer.pipe(
  Layer.provide(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      list: () =>
        Effect.succeed(roots.projects.map((workspaceRoot) => ({ workspaceRoot }) as never)),
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getShellSnapshot: (options) =>
        Effect.succeed({
          threads:
            options?.location === "archive"
              ? []
              : roots.threads.map((worktreePath) => ({ worktreePath })),
        } as never),
    }),
  ),
  Layer.provideMerge(JjCli.layer),
  Layer.provideMerge(
    Layer.mergeAll(NodeServices.layer, VcsProcess.layer.pipe(Layer.provide(NodeServices.layer))),
  ),
);

const jj = (cwd: string, args: ReadonlyArray<string>, withoutRepository = false) =>
  Effect.gen(function* () {
    const cli = yield* JjCli.JjCli;
    return yield* cli.read({ operation: "jj-test", root: cwd, args, withoutRepository });
  });

it.layer(TestLayer)("JjThreadWork", (it) => {
  it.effect("finds a thread's changes across repositories", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const app = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-app-" });
      const lib = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-lib-" });
      for (const root of [app, lib]) {
        yield* jj(root, ["git", "init", root], true);
      }
      yield* fileSystem.writeFileString(path.join(lib, "lib.ts"), "lib\n");
      yield* jj(lib, ["commit", "-m", "feat: lib\n\nT3-Thread: thread-x\nT3-Turn: 2\n"]);
      yield* fileSystem.writeFileString(path.join(app, "app.ts"), "app\n");
      yield* jj(app, ["commit", "-m", "feat: unrelated"]);
      roots.projects = [app];
      roots.threads = [lib];

      const work = yield* JjThreadWork.JjThreadWork;
      const found = yield* work.find(ThreadId.make("thread-x"));
      assert.deepStrictEqual(
        found.map((repository) => ({
          root: path.basename(repository.root),
          changes: repository.changes.map((change) => [change.description, change.turns]),
        })),
        [{ root: path.basename(lib), changes: [["feat: lib", [2]]] }],
      );
    }),
  );
});
