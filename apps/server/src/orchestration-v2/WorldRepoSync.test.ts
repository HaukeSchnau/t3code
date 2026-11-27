import { assert, it } from "@effect/vitest";
import {
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ThreadWorldRepo,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as WorldRepoSync from "./WorldRepoSync.ts";

const frontend: ThreadWorldRepo = {
  repo: "git.buildlinx.io/buildlinx/cloud/frontend",
  dir: "Repos/buildlinx/cloud/frontend",
  work: true,
};

it.effect("records a thread world's repos once on each thread that runs in it", () => {
  const recorded = Deferred.makeUnsafe<void>();
  const commands: OrchestrationV2ServerCommand[] = [];
  const thread = (id: string, worktreePath: string, worldRepos?: ReadonlyArray<ThreadWorldRepo>) =>
    ({
      id: ThreadId.make(id),
      worktreePath,
      ...(worldRepos === undefined ? {} : { worldRepos }),
    }) as OrchestrationV2ThreadShell;
  let threads = [
    thread("new", "/worlds/buildlinx/t3-a"),
    thread("recorded", "/worlds/buildlinx/t3-a", [frontend]),
    thread("other", "/worlds/buildlinx/t3-b"),
  ];
  const read = (cwd: string) => Stream.make({ cwd, repos: [frontend] });
  // A thread that starts in an existing thread world after its repos were recorded.
  const join = (id: string, worktreePath: string) =>
    Stream.fromEffect(
      Effect.sync(() => {
        threads = [...threads, thread(id, worktreePath)];
      }),
    ).pipe(Stream.drain);
  return Effect.gen(function* () {
    yield* Layer.build(WorldRepoSync.layer);
    yield* Deferred.await(recorded);
    assert.deepEqual(
      commands.map((command) => {
        if (command.type !== "thread.metadata.update") throw new Error("Unexpected command");
        return [command.threadId, command.worldRepos, command.expectedWorktreePath];
      }),
      [
        [ThreadId.make("new"), [frontend], "/worlds/buildlinx/t3-a"],
        [ThreadId.make("joined"), [frontend], "/worlds/buildlinx/t3-a"],
      ],
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          // Every status read publishes; a repeated read writes only to threads that joined since.
          streamWorldRepoChanges: read("/worlds/buildlinx/t3-a").pipe(
            Stream.concat(join("joined", "/worlds/buildlinx/t3-a")),
            Stream.concat(read("/worlds/buildlinx/t3-a")),
            Stream.ensuring(Deferred.succeed(recorded, undefined)),
          ),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getShellSnapshot: (options) =>
            Effect.succeed({
              schemaVersion: 2,
              snapshotSequence: 0,
              threads: threads.filter((shell) => shell.worktreePath === options?.worktreePath),
              archivedThreads: [],
            }),
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              if (command.type === "thread.metadata.update") {
                threads = threads.map((shell) =>
                  shell.id === command.threadId
                    ? { ...shell, worldRepos: command.worldRepos }
                    : shell,
                );
              }
              return { sequence: commands.length, storedEvents: [] };
            }),
        }),
      ),
    ),
  );
});
