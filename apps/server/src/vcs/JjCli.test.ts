import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as JjCli from "./JjCli.ts";
import * as VcsProcess from "./VcsProcess.ts";

const TestLayer = JjCli.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(NodeServices.layer, VcsProcess.layer.pipe(Layer.provide(NodeServices.layer))),
  ),
);

// The stale retry backs off on the real clock, which only the top-level `it` offers.
it.live("keeps unsnapshotted edits when another workspace made this one stale", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cli = yield* JjCli.JjCli;
      const jj = (root: string, args: ReadonlyArray<string>) =>
        cli.read({ operation: "jj-test", root, args });
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-stale-" });
      const fork = path.join(yield* fileSystem.makeTempDirectoryScoped(), "fork");
      yield* cli.run({
        operation: "jj-test",
        root: parent,
        withoutRepository: true,
        args: ["git", "init", parent],
      });
      yield* fileSystem.writeFileString(path.join(parent, "parent.ts"), "1\n");
      yield* jj(parent, ["workspace", "add", "--name", "fork", "-r", "@", fork]);
      yield* fileSystem.writeFileString(path.join(fork, "edited.ts"), "1\n");
      yield* jj(fork, ["util", "snapshot"]);
      yield* fileSystem.writeFileString(path.join(fork, "edited.ts"), "2\n");
      yield* fileSystem.writeFileString(path.join(fork, "fork.ts"), "fork\n");

      // The parent's snapshot rewrites the commit the fork's `@` sits on.
      yield* fileSystem.writeFileString(path.join(parent, "parent.ts"), "2\n");
      yield* jj(parent, ["util", "snapshot"]);
      yield* jj(fork, ["util", "snapshot"]);

      assert.isTrue(yield* fileSystem.exists(path.join(fork, "fork.ts")));
      assert.strictEqual(yield* fileSystem.readFileString(path.join(fork, "edited.ts")), "2\n");
      assert.strictEqual(
        yield* jj(fork, [
          "--ignore-working-copy",
          "log",
          "--no-graph",
          "-r",
          "@",
          "-T",
          'diff.files().map(|f| f.path()).join(",") ++ " " ++ divergent ++ " " ++ conflict',
        ]),
        "edited.ts,fork.ts false false",
      );
    }),
  ).pipe(Effect.provide(TestLayer)),
);
