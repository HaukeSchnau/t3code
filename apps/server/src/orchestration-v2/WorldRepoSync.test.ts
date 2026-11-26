import { assert, it } from "@effect/vitest";
import {
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ThreadWorldRepo,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as WorldRepoSync from "./WorldRepoSync.ts";

const frontend: ThreadWorldRepo = {
  repo: "git.buildlinx.io/buildlinx/cloud/frontend",
  dir: "Repos/buildlinx/cloud/frontend",
  work: true,
};

it.effect("records a thread world's repos once on the threads that still run in it", () => {
  const recorded = Deferred.makeUnsafe<void>();
  const commands: OrchestrationV2ServerCommand[] = [];
  const thread = (id: string, worktreePath: string, worldRepos?: ReadonlyArray<ThreadWorldRepo>) =>
    ({
      id: ThreadId.make(id),
      worktreePath,
      ...(worldRepos === undefined ? {} : { worldRepos }),
    }) as OrchestrationV2ThreadShell;
  const threads = [
    thread("new", "/worlds/buildlinx/t3-a"),
    // Reached only through a symlinked base dir.
    thread("linked", "/link/t3-c"),
    thread("recorded", "/worlds/buildlinx/t3-a", [frontend]),
    thread("other", "/worlds/buildlinx/t3-b"),
    thread("moved", "/worlds/buildlinx/t3-d"),
  ];
  // "moved" was still in t3-a when the sync looked its path up.
  const lookedUpPath = (shell: OrchestrationV2ThreadShell) =>
    shell.id === "moved" ? "/worlds/buildlinx/t3-a" : shell.worktreePath!;
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
        [ThreadId.make("linked"), [frontend], "/link/t3-c"],
      ],
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          realPath: (path) =>
            Effect.succeed(path === "/link/t3-c" ? "/worlds/buildlinx/t3-c" : path),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadWorktreePaths: () =>
            Effect.succeed(
              threads.map((shell) => ({ threadId: shell.id, worktreePath: lookedUpPath(shell) })),
            ),
        }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          // Every status read publishes; the second, unchanged read writes nothing.
          streamWorldRepoChanges: Stream.make(
            { cwd: "/worlds/buildlinx/t3-a", repos: [frontend] },
            { cwd: "/worlds/buildlinx/t3-a", repos: [frontend] },
            { cwd: "/worlds/buildlinx/t3-c", repos: [frontend] },
          ).pipe(Stream.ensuring(Deferred.succeed(recorded, undefined))),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getShellSnapshot: (options) =>
            Effect.succeed({
              schemaVersion: 2,
              snapshotSequence: 0,
              threads: threads.filter((shell) => options?.threadIds?.includes(shell.id) ?? true),
              archivedThreads: [],
            }),
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              return { sequence: commands.length, storedEvents: [] };
            }),
        }),
      ),
    ),
  );
});
