import {
  isDelegatedAppThread,
  isListedThreadLineage,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  continuedRunId,
  runStartedByUser,
  type ProjectionRecordField,
  type ProjectionRecordFilter,
  type ProjectionRecords,
} from "./ProjectionStore.ts";

type ReadRecords<E> = <K extends ProjectionRecordField>(
  threadId: ThreadId,
  fields: ReadonlyArray<K>,
  filter?: ProjectionRecordFilter,
) => Effect.Effect<ProjectionRecords<K>, E>;

/**
 * How a run ended: whether a user's message started it (following continuations back to the run
 * they continue) and whether its stop was requested. Null when the run is unknown.
 */
export const readRunEnd = Effect.fn("threadReturn.readRunEnd")(function* <E>(
  read: ReadRecords<E>,
  threadId: ThreadId,
  runId: RunId,
) {
  const { thread, runs } = yield* read(threadId, ["runs"], { runIds: [runId] });
  const run = runs[0];
  if (run === undefined) return null;
  const chain = [run];
  // Back to the run that started the chain, however long, so that run decides who started it.
  for (
    let sourceId = continuedRunId(run);
    sourceId !== undefined && !chain.some((candidate) => candidate.id === sourceId);
  ) {
    const source = (yield* read(threadId, ["runs"], { runIds: [sourceId] })).runs[0];
    if (source === undefined) break;
    chain.push(source);
    sourceId = continuedRunId(source);
  }
  const records = yield* read(threadId, ["messages", "turnItems"], {
    messageRunIds: chain.map((candidate) => candidate.id),
    messageRoles: ["user"],
    turnItemRunIds: [run.id],
    turnItemTypes: ["run_interrupt_request"],
  });
  return {
    thread,
    run,
    startedByUser: runStartedByUser(run, { runs: chain, messages: records.messages }),
    stopRequested: records.turnItems.length > 0,
  };
});

/**
 * The thread comes back to the user when a run they started ends or any run fails, and a failure
 * brings a settled thread back unless the user settled it after the failure. A run a wake, a
 * watcher or another agent started leaves the thread where the user's last action put it. Null
 * when nothing changes.
 */
export function threadAfterRunEnded(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly run: Pick<OrchestrationV2Run, "status" | "completedAt">;
  readonly startedByUser: boolean;
  readonly stopRequested: boolean;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread | null {
  const { thread, run } = input;
  if (run.completedAt === null || !isListedThreadLineage(thread.lineage)) return null;
  if (isDelegatedAppThread(thread)) return null;
  const failed = run.status === "failed";
  if (!failed && (!input.startedByUser || input.stopRequested)) return null;
  const returnedAt = DateTime.formatIso(run.completedAt);
  if (thread.returnedAt !== undefined && thread.returnedAt >= returnedAt) return null;
  const settledBefore =
    thread.settledOverride === "settled" &&
    (thread.settledAt === null || DateTime.isLessThan(thread.settledAt, run.completedAt));
  return failed && settledBefore
    ? {
        ...thread,
        returnedAt,
        settledOverride: null,
        settledAt: null,
        unsettledAt: input.now,
        updatedAt: input.now,
      }
    : { ...thread, returnedAt };
}
