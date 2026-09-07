import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";

export function isAutomaticCompletionRun(
  projection: OrchestrationV2ThreadProjection,
  run: OrchestrationV2Run,
): boolean {
  return projection.messages.some(
    (message) => message.id === run.userMessageId && message.delegatedCompletion !== undefined,
  );
}

export function queuedRunsInDeliveryOrder(
  projection: OrchestrationV2ThreadProjection,
): ReadonlyArray<OrchestrationV2Run> {
  const automaticCompletionMessageIds = new Set(
    projection.messages
      .filter((message) => message.delegatedCompletion !== undefined)
      .map((message) => message.id),
  );
  return projection.runs
    .filter((run) => run.status === "queued")
    .toSorted((left, right) => {
      const deliveryPriority =
        Number(automaticCompletionMessageIds.has(right.userMessageId)) -
        Number(automaticCompletionMessageIds.has(left.userMessageId));
      return (
        deliveryPriority ||
        (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
        left.ordinal - right.ordinal
      );
    });
}

/** A stopped or failed turn leaves follow-up work for the user to resume explicitly. */
export function isQueuePausedAfterRun(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "status" | "ordinal" | "startedAt">>,
): boolean {
  const latest = runs
    .filter((run) => run.status !== "queued" && !(run.status === "cancelled" && run.startedAt === null))
    .reduce<(typeof runs)[number] | undefined>(
      (latest, run) => latest === undefined || run.ordinal > latest.ordinal ? run : latest,
      undefined,
    );
  return latest !== undefined && (
    latest.status === "interrupted" || latest.status === "failed" ||
    latest.status === "cancelled" || latest.status === "rolled_back"
  );
}
