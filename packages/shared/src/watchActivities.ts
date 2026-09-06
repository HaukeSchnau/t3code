import type { OrchestrationThreadActivity } from "@t3tools/contracts";

/** Keep the durable diagnostic history out of chat and update one row per watch. */
export function collapseWatchActivities(activities: ReadonlyArray<OrchestrationThreadActivity>) {
  const result: OrchestrationThreadActivity[] = [];
  const positions = new Map<string, number>();
  for (const activity of activities) {
    if (!activity.kind.startsWith("thread-orchestration.watch.")) {
      result.push(activity);
      continue;
    }
    if (activity.kind === "thread-orchestration.watch.event") continue;
    const payload = activity.payload;
    if (typeof payload !== "object" || payload === null) continue;
    const watchId =
      "watchId" in payload
        ? payload.watchId
        : "watch" in payload &&
            typeof payload.watch === "object" &&
            payload.watch !== null &&
            "watchId" in payload.watch
          ? payload.watch.watchId
          : undefined;
    if (typeof watchId !== "string") continue;
    const position = positions.get(watchId);
    const summary =
      activity.kind === "thread-orchestration.watch.closed"
        ? activity.summary
        : "Watching for changes";
    if (position === undefined) {
      positions.set(watchId, result.length);
      result.push({ ...activity, summary });
    } else {
      const original = result[position]!;
      result[position] = { ...activity, id: original.id, createdAt: original.createdAt, summary };
    }
  }
  return result;
}
