import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as JjCli from "../vcs/JjCli.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as JjStatusReader from "./JjStatusReader.ts";

const TestLayer = JjStatusReader.layer.pipe(
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

it.layer(TestLayer)("JjStatusReader", (it) => {
  it.effect("reads the stack with trailers, bookmarks and the trunk label", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-status-" });
      yield* jj(cwd, ["git", "init", cwd], true);
      yield* fileSystem.writeFileString(path.join(cwd, "base.ts"), "base\n");
      yield* jj(cwd, ["commit", "-m", "base"]);
      yield* jj(cwd, ["bookmark", "create", "main", "-r", "@-"]);
      yield* jj(cwd, ["config", "set", "--repo", 'revset-aliases."trunk()"', "main"]);
      yield* fileSystem.writeFileString(path.join(cwd, "a.ts"), "a\n");
      yield* jj(cwd, [
        "commit",
        "-m",
        "feat: add a\n\nT3-Thread: thread-a\nT3-Turn: 1\nT3-Turn: 3\n",
      ]);
      yield* jj(cwd, ["bookmark", "create", "t3code/add-a", "-r", "@-"]);
      yield* jj(cwd, ["util", "snapshot"]);

      const reader = yield* JjStatusReader.JjStatusReader;
      const status = yield* reader.read(cwd);
      assert.isNotNull(status);
      assert.deepStrictEqual(status!.trunk?.label, "main");
      assert.deepStrictEqual(
        status!.stack.map((entry) => ({
          description: entry.description,
          workingCopy: entry.workingCopy,
          empty: entry.empty,
          threadId: entry.threadId,
          turns: entry.turns,
          bookmarks: entry.bookmarks,
        })),
        [
          {
            description: "",
            workingCopy: true,
            empty: true,
            threadId: null,
            turns: [],
            bookmarks: [],
          },
          {
            description: "feat: add a",
            workingCopy: false,
            empty: false,
            threadId: "thread-a",
            turns: [1, 3],
            bookmarks: ["t3code/add-a"],
          },
        ],
      );
    }),
  );
});
