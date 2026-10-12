import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import { CheckpointRef, type VcsError } from "@t3tools/contracts";
import { parseTurnDiffFilesFromNumstat } from "../checkpointing/Diffs.ts";
import * as JjCli from "./JjCli.ts";
import * as JjVcsDriver from "./JjVcsDriver.ts";
import { runVcsDriverContractSuite } from "./testing/VcsDriverContractHarness.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";
import * as VcsProcess from "./VcsProcess.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";

const PlatformLayer = Layer.mergeAll(
  NodeServices.layer,
  VcsProcess.layer.pipe(Layer.provide(NodeServices.layer)),
);
const JjCliLayer = JjCli.layer.pipe(Layer.provideMerge(PlatformLayer));
const DriverLayer = Layer.effect(
  VcsDriver.VcsDriver,
  Effect.map(JjVcsDriver.makeVcsDriverShape(), (driver) => VcsDriver.VcsDriver.of(driver)),
).pipe(Layer.provideMerge(JjCliLayer));

const jjAt = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const jj = yield* JjCli.JjCli;
    return yield* jj.run({
      operation: "jj-test",
      root: cwd,
      args,
      withoutRepository: args[0] === "git" && args[1] === "init",
    });
  });

const writeFile = (cwd: string, relativePath: string, contents: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const absolutePath = path.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* fileSystem.writeFileString(absolutePath, contents);
  });

runVcsDriverContractSuite<JjCli.JjCli, VcsError | PlatformError.PlatformError>({
  name: "jj",
  kind: "jj",
  layer: DriverLayer,
  fixture: {
    createRepo: (cwd) => jjAt(cwd, ["git", "init", cwd]).pipe(Effect.asVoid),
    writeFile,
    commit: (cwd, message) => jjAt(cwd, ["commit", "-m", message]).pipe(Effect.asVoid),
    ignorePath: (cwd, pattern) => writeFile(cwd, ".gitignore", `${pattern}\n`),
  },
});

it.layer(DriverLayer)("jj checkpoints", (it) => {
  const makeRepo = (colocated: boolean) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-checkpoint-" });
      yield* jjAt(cwd, ["git", "init", ...(colocated ? [] : ["--no-colocate"]), cwd]);
      yield* writeFile(cwd, "a.ts", "one\n");
      yield* jjAt(cwd, ["commit", "-m", "base"]);
      return cwd;
    });

  for (const colocated of [true, false]) {
    it.effect(
      `captures, diffs and restores ${colocated ? "colocated" : "jj-only"} working copies`,
      () =>
        Effect.gen(function* () {
          const driver = yield* VcsDriver.VcsDriver;
          const checkpoints = driver.checkpoints!;
          const cwd = yield* makeRepo(colocated);
          const before = CheckpointRef.make("refs/t3/test/0");
          const after = CheckpointRef.make("refs/t3/test/1");

          assert.isFalse(yield* checkpoints.hasCheckpointRef({ cwd, checkpointRef: before }));
          yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: before });
          yield* writeFile(cwd, "a.ts", "one\ntwo\n");
          yield* writeFile(cwd, "b.ts", "new\n");
          yield* checkpoints.captureCheckpoint({ cwd, checkpointRef: after });
          assert.isTrue(yield* checkpoints.hasCheckpointRef({ cwd, checkpointRef: after }));

          const numstat = yield* checkpoints.diffCheckpoints({
            cwd,
            fromCheckpointRef: before,
            toCheckpointRef: after,
            ignoreWhitespace: false,
            format: "numstat",
          });
          assert.deepStrictEqual(parseTurnDiffFilesFromNumstat(numstat), [
            { path: "a.ts", additions: 1, deletions: 0 },
            { path: "b.ts", additions: 1, deletions: 0 },
          ]);
          const patch = yield* checkpoints.diffCheckpoints({
            cwd,
            fromCheckpointRef: before,
            toCheckpointRef: after,
            ignoreWhitespace: false,
          });
          assert.include(patch, "diff --git a/b.ts b/b.ts");

          assert.isTrue(yield* checkpoints.restoreCheckpoint({ cwd, checkpointRef: before }));
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          assert.equal(yield* fileSystem.readFileString(path.join(cwd, "a.ts")), "one\n");
          assert.isFalse(yield* fileSystem.exists(path.join(cwd, "b.ts")));
          // jj keeps every earlier version of @, so the later checkpoint still resolves.
          assert.isTrue(yield* checkpoints.hasCheckpointRef({ cwd, checkpointRef: after }));
        }),
    );
  }
});

describe("VcsDriverRegistry with jj", () => {
  const RegistryLayer = Layer.effect(
    VcsDriverRegistry.VcsDriverRegistry,
    VcsDriverRegistry.make,
  ).pipe(Layer.provide(VcsProjectConfig.layer), Layer.provideMerge(JjCliLayer));

  it.layer(RegistryLayer)((it) => {
    it.effect("detects jj first and marks colocated repositories as Git-compatible", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        const colocated = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-colocated-" });
        const jjOnly = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-only-" });
        yield* jjAt(colocated, ["git", "init", colocated]);
        yield* jjAt(jjOnly, ["git", "init", "--no-colocate", jjOnly]);

        const colocatedHandle = yield* registry.detect({ cwd: colocated });
        assert.equal(colocatedHandle?.kind, "jj");
        assert.isTrue(colocatedHandle?.gitCompatible);
        const jjOnlyHandle = yield* registry.detect({ cwd: jjOnly });
        assert.equal(jjOnlyHandle?.kind, "jj");
        assert.isFalse(jjOnlyHandle?.gitCompatible);
        assert.equal(
          (yield* registry.detect({ cwd: colocated, requestedKind: "git" }))?.kind,
          "git",
        );
      }),
    );
  });
});
