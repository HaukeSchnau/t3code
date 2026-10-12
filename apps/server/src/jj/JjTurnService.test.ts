import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { CheckpointRef, RunId, ThreadId } from "@t3tools/contracts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as JjCli from "../vcs/JjCli.ts";
import * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as JjCommitWriter from "./JjCommitWriter.ts";
import * as JjThreadLayer from "./JjThreadLayer.ts";
import * as JjTurnService from "./JjTurnService.ts";
import { withTrailers } from "./JjTurnService.ts";

/** What the fake projection reports: running runs and the paths each one's provider reported. */
const world = {
  running: new Set<string>(),
  reported: new Map<string, ReadonlyArray<string>>(),
};

const ProjectionsFake = Layer.mock(ProjectionStore.ProjectionStoreV2)({
  getThreadShell: (threadId) =>
    Effect.succeed({ id: threadId, title: "Parser", projectId: null } as never),
  getThreadRecords: (threadId, _fields, filter) =>
    Effect.succeed({
      thread: { id: threadId },
      runs: (filter?.runIds ?? []).map((id) => ({
        id,
        status: world.running.has(id) ? "running" : "completed",
      })),
      turnItems: (filter?.turnItemRunIds ?? []).flatMap((runId) =>
        (world.reported.get(runId ?? "") ?? []).map((fileName) => ({
          type: "file_change",
          fileName,
        })),
      ),
    } as never),
});

const PlatformLayer = Layer.mergeAll(
  NodeServices.layer,
  VcsProcess.layer.pipe(Layer.provide(NodeServices.layer)),
);
const TestLayer = JjTurnService.layer.pipe(
  Layer.provide(ProjectionsFake),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(
    Layer.mock(JjThreadLayer.JjThreadLayer)({
      writeForTurn: () => Effect.void,
      environmentFor: () => Effect.succeed({}),
    }),
  ),
  Layer.provide(
    Layer.mock(JjCommitWriter.JjCommitWriter)({
      commitMessage: () => Effect.succeed(null),
      pullRequest: () => Effect.succeed(null),
    }),
  ),
  Layer.provideMerge(JjCli.layer),
  Layer.provideMerge(PlatformLayer),
);

const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const runA1 = RunId.make("run:thread:thread-a:ordinal:1");
const runA2 = RunId.make("run:thread:thread-a:ordinal:2");
const runB1 = RunId.make("run:thread:thread-b:ordinal:1");

const jj = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const cli = yield* JjCli.JjCli;
    return yield* cli.read({ operation: "jj-test", root: cwd, args });
  });

const write = (cwd: string, file: string, contents: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.writeFileString(path.join(cwd, file), contents);
  });

const exists = (cwd: string, file: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fileSystem.exists(path.join(cwd, file));
  });

const makeRepo = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-turns-" });
  const cli = yield* JjCli.JjCli;
  yield* cli.run({
    operation: "jj-test",
    root: cwd,
    withoutRepository: true,
    args: ["git", "init", cwd],
  });
  yield* write(cwd, "base.ts", "base\n");
  yield* jj(cwd, ["commit", "-m", "base"]);
  world.running.clear();
  world.reported.clear();
  return cwd;
});

/** Records `@` as a checkpoint the way the driver does after a seal. */
const checkpoint = (cwd: string, name: string) =>
  Effect.gen(function* () {
    const driver = yield* JjVcsDriver.makeVcsDriverShape();
    const ref = CheckpointRef.make(`refs/t3/test/${name}`);
    yield* driver.checkpoints!.captureCheckpoint({ cwd, checkpointRef: ref });
    return ref;
  });

const start = (cwd: string, threadId: ThreadId, runId: RunId, ordinal: number) =>
  Effect.gen(function* () {
    world.running.add(runId);
    const turns = yield* JjTurnService.JjTurnService;
    yield* turns.turnStarted({ threadId, runId, ordinal, cwd });
  });

const seal = (cwd: string, threadId: ThreadId, runId: RunId, ordinal: number) =>
  Effect.gen(function* () {
    world.running.delete(runId);
    const turns = yield* JjTurnService.JjTurnService;
    yield* turns.sealTurn({ threadId, runId, ordinal, cwd, failed: false });
  });

const changes = (cwd: string) =>
  Effect.map(
    jj(cwd, [
      "--ignore-working-copy",
      "log",
      "--no-graph",
      "-r",
      '::@ ~ ::root() ~ description(exact:"base\\n")',
      "-T",
      'description.first_line() ++ " | " ++ diff.files().map(|f| f.path()).join(",") ++ " | " ++ trailers.map(|t| t.key() ++ "=" ++ t.value()).join(",") ++ "\\n"',
    ]),
    (output) =>
      output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
  );

describe("withTrailers", () => {
  it("adds a trailer paragraph, or extends an existing one", () => {
    assert.equal(withTrailers("feat: x\n", "t", 2), "feat: x\n\nT3-Thread: t\nT3-Turn: 2\n");
    assert.equal(
      withTrailers("feat: x\n\nT3-Thread: t\nT3-Turn: 1\n", "t", 2),
      "feat: x\n\nT3-Thread: t\nT3-Turn: 1\nT3-Turn: 2\n",
    );
  });
});

it.layer(TestLayer)("JjTurnService", (it) => {
  it.effect("seals a turn's files into a change with trailers, and reverts later turns", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo;
      const cp0 = yield* checkpoint(cwd, "0");
      yield* start(cwd, threadA, runA1, 1);
      yield* write(cwd, "a.ts", "a\n");
      yield* seal(cwd, threadA, runA1, 1);
      const cp1 = yield* checkpoint(cwd, "1");

      yield* start(cwd, threadA, runA2, 2);
      yield* write(cwd, "b.ts", "b\n");
      yield* seal(cwd, threadA, runA2, 2);

      assert.deepStrictEqual(yield* changes(cwd), [
        "|  |",
        "wip: Parser (turn 2) | b.ts | T3-Thread=thread-a,T3-Turn=2",
        "wip: Parser (turn 1) | a.ts | T3-Thread=thread-a,T3-Turn=1",
      ]);

      const turns = yield* JjTurnService.JjTurnService;
      yield* turns.revert({ threadId: threadA, cwd, checkpointRef: cp1 });
      assert.isTrue(yield* exists(cwd, "a.ts"));
      assert.isFalse(yield* exists(cwd, "b.ts"));
      assert.deepStrictEqual(yield* changes(cwd), [
        "|  |",
        "wip: Parser (turn 1) | a.ts | T3-Thread=thread-a,T3-Turn=1",
      ]);

      yield* turns.revert({ threadId: threadA, cwd, checkpointRef: cp0 });
      assert.isFalse(yield* exists(cwd, "a.ts"));
    }),
  );

  it.effect("tags the agent's own commits and leaves nothing to seal", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo;
      yield* start(cwd, threadA, runA1, 1);
      yield* write(cwd, "a.ts", "a\n");
      yield* jj(cwd, ["commit", "-m", "feat: add a"]);
      yield* seal(cwd, threadA, runA1, 1);
      assert.deepStrictEqual(yield* changes(cwd), [
        "|  |",
        "feat: add a | a.ts | T3-Thread=thread-a,T3-Turn=1",
      ]);
    }),
  );

  it.effect("merges a fork's changes from its own workspace into the parent's stack", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo;
      const fileSystem = yield* FileSystem.FileSystem;
      const forkCwd = `${yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-fork-" })}/fork`;
      yield* jj(cwd, ["workspace", "add", "--name", "fork", "-r", "@", forkCwd]);
      const threadF = ThreadId.make("thread-fork");
      const runF1 = RunId.make("run:thread:thread-fork:ordinal:1");
      yield* start(forkCwd, threadF, runF1, 1);
      yield* write(forkCwd, "fork.ts", "fork\n");
      yield* seal(forkCwd, threadF, runF1, 1);
      assert.isFalse(yield* exists(cwd, "fork.ts"));

      const turns = yield* JjTurnService.JjTurnService;
      yield* turns.mergeBack({ forkCwd, parentCwd: cwd });
      assert.isTrue(yield* exists(cwd, "fork.ts"));
      assert.deepStrictEqual((yield* changes(cwd)).slice(1), [
        "wip: Parser (turn 1) | fork.ts | T3-Thread=thread-fork,T3-Turn=1",
      ]);
    }),
  );

  it.effect("seals only each thread's files when two threads share the checkout", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo;
      const cpA = yield* checkpoint(cwd, "a0");
      yield* start(cwd, threadA, runA1, 1);
      yield* start(cwd, threadB, runB1, 1);
      yield* write(cwd, "a.ts", "a\n");
      yield* write(cwd, "b.ts", "b\n");
      yield* write(cwd, "generated.ts", "?\n");
      world.reported.set(runA1, ["a.ts"]);
      world.reported.set(runB1, [`${cwd}/b.ts`]);

      yield* seal(cwd, threadA, runA1, 1);
      const turns = yield* JjTurnService.JjTurnService;
      const afterA = yield* changes(cwd);
      assert.deepStrictEqual(afterA.slice(1), [
        "wip: Parser (turn 1) | a.ts | T3-Thread=thread-a,T3-Turn=1",
      ]);

      yield* seal(cwd, threadB, runB1, 1);
      assert.deepStrictEqual((yield* changes(cwd)).slice(0, 2), [
        "| generated.ts |",
        "wip: Parser (turn 1) | b.ts | T3-Thread=thread-b,T3-Turn=1",
      ]);
      const state = yield* turns.readState(cwd);
      assert.strictEqual(state.owners["generated.ts"], null);

      // Reverting thread A keeps thread B's change and the unattributed file.
      yield* turns.revert({ threadId: threadA, cwd, checkpointRef: cpA });
      assert.isFalse(yield* exists(cwd, "a.ts"));
      assert.isTrue(yield* exists(cwd, "b.ts"));
      assert.isTrue(yield* exists(cwd, "generated.ts"));
    }),
  );

  // B's seal commits the change that was `@` when A's turn started, so it
  // looks new to A. It must stay B's.
  it.effect("keeps a sibling's change sealed during the thread's turn", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo;
      const cpA = yield* checkpoint(cwd, "a0");
      yield* start(cwd, threadA, runA1, 1);
      yield* start(cwd, threadB, runB1, 1);
      world.reported.set(runA1, ["a.ts"]);
      world.reported.set(runB1, ["b.ts"]);
      yield* write(cwd, "b.ts", "b\n");
      yield* seal(cwd, threadB, runB1, 1);
      yield* write(cwd, "a.ts", "a\n");
      yield* seal(cwd, threadA, runA1, 1);

      const turns = yield* JjTurnService.JjTurnService;
      yield* turns.revert({ threadId: threadA, cwd, checkpointRef: cpA });
      assert.isFalse(yield* exists(cwd, "a.ts"));
      assert.isTrue(yield* exists(cwd, "b.ts"));
      assert.deepStrictEqual((yield* changes(cwd)).slice(1), [
        "wip: Parser (turn 1) | b.ts | T3-Thread=thread-b,T3-Turn=1",
      ]);
    }),
  );

  it.effect("keeps work the agent merged in when reverting its turn", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo;
      yield* jj(cwd, ["new", "@-", "-m", "feat: side work"]);
      yield* write(cwd, "side.ts", "side\n");
      yield* jj(cwd, ["bookmark", "create", "side", "-r", "@"]);
      yield* jj(cwd, ["new", "@-"]);
      const cp0 = yield* checkpoint(cwd, "0");

      yield* start(cwd, threadA, runA1, 1);
      yield* jj(cwd, ["new", "@", "side", "-m", "merge side"]);
      yield* write(cwd, "a.ts", "a\n");
      yield* seal(cwd, threadA, runA1, 1);

      const turns = yield* JjTurnService.JjTurnService;
      yield* turns.revert({ threadId: threadA, cwd, checkpointRef: cp0 });
      assert.isFalse(yield* exists(cwd, "a.ts"));
      assert.strictEqual(
        yield* jj(cwd, [
          "--ignore-working-copy",
          "log",
          "--no-graph",
          "-r",
          "side",
          "-T",
          "description",
        ]),
        "feat: side work",
      );
    }),
  );

  // A's checkpoint `@` still held B's unsealed file; A's next seal commits into
  // that same change, which must still count as A's later work.
  it.effect("reverts a turn sealed into the change its checkpoint left as `@`", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo;
      yield* start(cwd, threadA, runA1, 1);
      yield* start(cwd, threadB, runB1, 1);
      world.reported.set(runA1, ["a1.ts"]);
      world.reported.set(runA2, ["a2.ts"]);
      world.reported.set(runB1, ["b.ts"]);
      yield* write(cwd, "a1.ts", "a1\n");
      yield* write(cwd, "b.ts", "b\n");
      yield* seal(cwd, threadA, runA1, 1);
      const cpA1 = yield* checkpoint(cwd, "a1");

      yield* start(cwd, threadA, runA2, 2);
      yield* write(cwd, "a2.ts", "a2\n");
      yield* seal(cwd, threadA, runA2, 2);
      yield* seal(cwd, threadB, runB1, 1);

      const turns = yield* JjTurnService.JjTurnService;
      yield* turns.revert({ threadId: threadA, cwd, checkpointRef: cpA1 });
      assert.isTrue(yield* exists(cwd, "a1.ts"));
      assert.isFalse(yield* exists(cwd, "a2.ts"));
      assert.isTrue(yield* exists(cwd, "b.ts"));
    }),
  );

  it.effect("keeps a sibling's files that the agent's commit swept up", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo;
      const cpA = yield* checkpoint(cwd, "a0");
      yield* start(cwd, threadA, runA1, 1);
      yield* start(cwd, threadB, runB1, 1);
      world.reported.set(runA1, ["a.ts"]);
      world.reported.set(runB1, ["b.ts"]);
      yield* write(cwd, "a.ts", "a\n");
      yield* write(cwd, "b.ts", "b\n");
      // The agent commits everything, B's file included, with its own trailer.
      yield* jj(cwd, ["commit", "-m", "feat: a\n\nT3-Thread: thread-a\n"]);
      yield* seal(cwd, threadA, runA1, 1);
      yield* seal(cwd, threadB, runB1, 1);

      const turns = yield* JjTurnService.JjTurnService;
      yield* turns.revert({ threadId: threadA, cwd, checkpointRef: cpA });
      assert.isFalse(yield* exists(cwd, "a.ts"));
      assert.isTrue(yield* exists(cwd, "b.ts"));
    }),
  );

  it.effect("keeps a change a fork's workspace starts from when reverting the parent", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo;
      const fileSystem = yield* FileSystem.FileSystem;
      const cp0 = yield* checkpoint(cwd, "0");
      yield* start(cwd, threadA, runA1, 1);
      yield* write(cwd, "a.ts", "a\n");
      yield* seal(cwd, threadA, runA1, 1);

      const turns = yield* JjTurnService.JjTurnService;
      const base = yield* turns.forkBase(cwd);
      assert.isNotNull(base);
      const forkCwd = `${yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-fork-" })}/fork`;
      yield* jj(cwd, ["workspace", "add", "--name", "fork", "-r", base!, forkCwd]);

      yield* turns.revert({ threadId: threadA, cwd, checkpointRef: cp0 });
      assert.isFalse(yield* exists(cwd, "a.ts"));
      yield* jj(forkCwd, ["util", "snapshot"]);
      assert.isTrue(yield* exists(forkCwd, "a.ts"));
    }),
  );

  it.effect("refuses to revert to a checkpoint jj never recorded", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo;
      const turns = yield* JjTurnService.JjTurnService;
      const result = yield* Effect.exit(
        turns.prepareRevert({
          threadId: threadA,
          cwd,
          checkpointRef: CheckpointRef.make("refs/t3/test/before-jj"),
        }),
      );
      assert.strictEqual(result._tag, "Failure");
    }),
  );

  it.effect("starts a fork below `@` only while `@` is empty", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo;
      const turns = yield* JjTurnService.JjTurnService;
      const parent = yield* jj(cwd, ["log", "--no-graph", "-r", "@-", "-T", "commit_id"]);
      assert.strictEqual(yield* turns.forkBase(cwd), parent);
      yield* write(cwd, "wip.ts", "wip\n");
      assert.isNull(yield* turns.forkBase(cwd));
    }),
  );
});
