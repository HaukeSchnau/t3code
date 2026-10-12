import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import { CheckpointRef } from "@t3tools/contracts";
import * as JjCli from "../vcs/JjCli.ts";
import * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as JjCommitWriter from "./JjCommitWriter.ts";
import * as JjStatusReader from "./JjStatusReader.ts";
import * as JjThreadLayer from "./JjThreadLayer.ts";
import * as JjTurnService from "./JjTurnService.ts";
import * as JjWorkflow from "./JjWorkflow.ts";
import { bookmarkSlug, mergeDescriptions, stripT3Trailers } from "./JjWorkflow.ts";

describe("jj description helpers", () => {
  it("strips T3 trailers and the blank line left behind", () => {
    assert.equal(
      stripT3Trailers("feat: x\n\nBody.\n\nT3-Thread: t\nT3-Turn: 1\n"),
      "feat: x\n\nBody.\n",
    );
    assert.equal(stripT3Trailers("feat: x\n"), "feat: x\n");
  });

  it("merges a squashed change into its parent with one trailer block", () => {
    assert.equal(
      mergeDescriptions(
        "feat: parser\n\nT3-Thread: t\nT3-Turn: 1\n",
        "fix: bom\n\nT3-Thread: t\nT3-Turn: 2\n",
      ),
      "feat: parser\n\nfix: bom\n\nT3-Thread: t\nT3-Turn: 1\nT3-Turn: 2\n",
    );
  });

  it("names bookmarks after the subject without its conventional prefix", () => {
    assert.equal(
      bookmarkSlug("feat(web): Add config parser!\n", "kxqvmpst"),
      "t3code/add-config-parser",
    );
    assert.equal(bookmarkSlug("", "kxqvmpstabcd"), "t3code/kxqvmpst");
  });
});

const PlatformLayer = Layer.mergeAll(
  NodeServices.layer,
  VcsProcess.layer.pipe(Layer.provide(NodeServices.layer)),
);
const ServicesLayer = JjWorkflow.layer.pipe(
  Layer.provideMerge(JjTurnService.layer),
  Layer.provideMerge(JjStatusReader.layer),
  Layer.provide(
    Layer.mock(JjThreadLayer.JjThreadLayer)({
      writeForTurn: () => Effect.void,
      environmentFor: () => Effect.succeed({}),
    }),
  ),
  Layer.provide(
    Layer.mock(JjCommitWriter.JjCommitWriter)({
      commitMessage: () => Effect.succeed({ subject: "feat: generated", body: "" }),
      pullRequest: () => Effect.succeed(null),
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell: () => Effect.succeed(null),
      getThreadRecords: (threadId) =>
        Effect.succeed({ thread: { id: threadId }, runs: [] } as never),
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      findActiveByWorkspaceRoot: () => Effect.succeedNone,
    }),
  ),
  Layer.provide(
    Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
      resolveLink: () => Effect.die("not used"),
    }),
  ),
  Layer.provide(
    Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
      refreshStatus: () => Effect.die("not used"),
    }),
  ),
  Layer.provide(ServerSettings.layerTest({ jjStripTrailersRemotes: ["origin"] })),
  Layer.provideMerge(JjCli.layer),
  Layer.provideMerge(PlatformLayer),
);

const jj = (cwd: string, args: ReadonlyArray<string>, withoutRepository = false) =>
  Effect.gen(function* () {
    const cli = yield* JjCli.JjCli;
    return yield* cli.read({ operation: "jj-test", root: cwd, args, withoutRepository });
  });

it.layer(ServicesLayer)("JjWorkflow", (it) => {
  it.effect("commits with a generated message and pushes a new bookmark without T3 trailers", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const remote = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-remote-" });
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-workflow-" });
      yield* Effect.promise(() =>
        import("node:child_process").then(({ execFileSync }) =>
          execFileSync("git", ["init", "--bare", "--initial-branch=main", remote]),
        ),
      );
      yield* jj(cwd, ["git", "init", cwd], true);
      yield* jj(cwd, ["git", "remote", "add", "origin", remote]);
      yield* fileSystem.writeFileString(path.join(cwd, "base.ts"), "base\n");
      yield* jj(cwd, ["commit", "-m", "base"]);
      yield* jj(cwd, ["bookmark", "create", "main", "-r", "@-"]);
      yield* jj(cwd, ["git", "push", "--remote", "origin", "-b", "main"]);

      const workflow = yield* JjWorkflow.JjWorkflow;
      yield* fileSystem.writeFileString(path.join(cwd, "a.ts"), "a\n");
      const committed = yield* workflow.runAction({ cwd, action: { _tag: "commit" } });
      assert.equal(committed.summary, "Committed: feat: generated");
      yield* jj(cwd, [
        "describe",
        "-r",
        "@-",
        "-m",
        "feat: generated\n\nT3-Thread: t\nT3-Turn: 1\n",
      ]);

      const pushed = yield* workflow.runAction({ cwd, action: { _tag: "push" } });
      assert.equal(pushed.summary, "Pushed t3code/generated");
      const remoteMessage = yield* Effect.promise(() =>
        import("node:child_process").then(({ execFileSync }) =>
          execFileSync(
            "git",
            ["--git-dir", remote, "log", "-1", "--format=%B", "t3code/generated"],
            {
              encoding: "utf8",
            },
          ),
        ),
      );
      assert.equal(remoteMessage.trim(), "feat: generated");
    }),
  );

  it.effect("undoes a revert in one step", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-undo-" });
      yield* jj(cwd, ["git", "init", cwd], true);
      yield* fileSystem.writeFileString(path.join(cwd, "base.ts"), "base\n");
      yield* jj(cwd, ["commit", "-m", "base"]);
      const driver = yield* JjVcsDriver.makeVcsDriverShape();
      const checkpointRef = CheckpointRef.make("refs/t3/test/0");
      yield* driver.checkpoints!.captureCheckpoint({ cwd, checkpointRef });

      const turns = yield* JjTurnService.JjTurnService;
      yield* fileSystem.writeFileString(path.join(cwd, "a.ts"), "a\n");
      yield* turns.sealTurn({
        threadId: "t" as never,
        runId: "r1" as never,
        ordinal: 1,
        cwd,
        failed: false,
      });
      yield* turns.revert({ threadId: "t" as never, cwd, checkpointRef });
      assert.isFalse(yield* fileSystem.exists(path.join(cwd, "a.ts")));

      const workflow = yield* JjWorkflow.JjWorkflow;
      yield* workflow.runAction({ cwd, action: { _tag: "undo" } });
      assert.isTrue(yield* fileSystem.exists(path.join(cwd, "a.ts")));
    }),
  );

  it.effect("refuses to rewrite files while a turn is running", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-guard-" });
      yield* jj(cwd, ["git", "init", cwd], true);
      const turns = yield* JjTurnService.JjTurnService;
      yield* turns.turnStarted({
        threadId: "t" as never,
        runId: "r" as never,
        ordinal: 1,
        cwd,
      });
      const workflow = yield* JjWorkflow.JjWorkflow;
      const result = yield* workflow
        .runAction({ cwd, action: { _tag: "rebase" } })
        .pipe(Effect.flip);
      assert.include(result.detail, "A turn is running");
    }),
  );
});
