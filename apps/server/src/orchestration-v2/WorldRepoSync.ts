import { CommandId, type ThreadWorldRepo } from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import { threadWorldReposKey } from "../world/worldStatus.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/**
 * Records a thread world's checked-out repos on its thread (patches/worlds.md), so lists show
 * them without asking the daemon, and keep showing them after the thread world is torn down.
 */
const makeRecord = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const fs = yield* FileSystem.FileSystem;
  // Every status read publishes; a thread world's repos are written once per change. A failed
  // write leaves the entry alone, so the next read retries it.
  const recorded = new Map<string, string>();
  return Effect.fn("WorldRepoSync.record")(function* (input: {
    readonly cwd: string;
    readonly repos: ReadonlyArray<ThreadWorldRepo>;
  }) {
    const key = threadWorldReposKey(input.repos);
    if (recorded.get(input.cwd) === key) return;
    recorded.delete(input.cwd);
    const paths = yield* projections.getThreadWorktreePaths({ includeArchived: true });
    // T3 names thread worlds itself, so only a symlinked base dir needs the real paths.
    const matched = paths.filter((thread) => thread.worktreePath === input.cwd);
    if (matched.length === 0) {
      for (const thread of paths) {
        const realPath = yield* fs
          .realPath(thread.worktreePath)
          .pipe(Effect.orElseSucceed(() => null));
        if (realPath === input.cwd) matched.push(thread);
      }
    }
    if (matched.length === 0) return;
    const worktreePaths = new Map(matched.map((thread) => [thread.threadId, thread.worktreePath]));
    const snapshot = yield* threads.getShellSnapshot({ threadIds: [...worktreePaths.keys()] });
    let complete = true;
    for (const thread of [...snapshot.threads, ...snapshot.archivedThreads]) {
      // A thread that moved to another workspace since the lookup keeps its new repos.
      if (thread.worktreePath !== worktreePaths.get(thread.id)) continue;
      if (thread.worldRepos !== undefined && threadWorldReposKey(thread.worldRepos) === key) {
        continue;
      }
      yield* threads
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(yield* randomUuidV4),
          threadId: thread.id,
          worldRepos: input.repos,
          expectedWorktreePath: thread.worktreePath,
        })
        .pipe(
          Effect.catchTags({
            OrchestratorDispatchError: (cause) => {
              complete = false;
              return Effect.logWarning("Recording a thread world's repos was rejected", {
                threadId: thread.id,
                cause,
              });
            },
          }),
        );
    }
    if (complete) recorded.set(input.cwd, key);
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const record = yield* makeRecord;
    const worlds = yield* KeyedLock.makeRunner<string>();
    yield* forkParked(
      Stream.runForEach(broadcaster.streamWorldRepoChanges, (input) =>
        worlds.run(
          input.cwd,
          record(input).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to record a thread world's repos", {
                cwd: input.cwd,
                cause,
              }),
            ),
          ),
        ),
      ),
    );
  }),
);
