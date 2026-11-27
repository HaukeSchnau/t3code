import { CommandId, type ThreadWorldRepo } from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import { threadWorldReposKey } from "../world/worldStatus.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/**
 * Records a thread world's checked-out repos on its thread (patches/worlds.md), so lists show
 * them without asking the daemon, and keep showing them after the thread world is torn down.
 */
const makeRecord = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  return Effect.fn("WorldRepoSync.record")(function* (input: {
    readonly cwd: string;
    readonly repos: ReadonlyArray<ThreadWorldRepo>;
  }) {
    const key = threadWorldReposKey(input.repos);
    // Every status read publishes; only threads whose recorded repos differ get a write. The
    // worktree path index serves this lookup, so it reads only the threads at this path.
    const snapshot = yield* threads.getShellSnapshot({ worktreePath: input.cwd });
    for (const thread of [...snapshot.threads, ...snapshot.archivedThreads]) {
      if (thread.worldRepos !== undefined && threadWorldReposKey(thread.worldRepos) === key) {
        continue;
      }
      yield* threads
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(yield* randomUuidV4),
          threadId: thread.id,
          worldRepos: input.repos,
          // A thread that moved to another workspace meanwhile keeps its new repos.
          expectedWorktreePath: thread.worktreePath,
        })
        .pipe(
          Effect.catchTags({
            OrchestratorDispatchError: (cause) =>
              Effect.logWarning("Recording a thread world's repos was rejected", {
                threadId: thread.id,
                cause,
              }),
          }),
        );
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const record = yield* makeRecord;
    yield* forkParked(
      Stream.runForEach(broadcaster.streamWorldRepoChanges, (input) =>
        record(input).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to record a thread world's repos", {
              cwd: input.cwd,
              cause,
            }),
          ),
        ),
      ),
    );
  }),
);
