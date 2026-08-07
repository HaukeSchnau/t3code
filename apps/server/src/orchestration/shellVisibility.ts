import type { OrchestrationEvent, OrchestrationThreadActivity } from "@t3tools/contracts";

export const SHELL_SUMMARY_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "approval.requested",
  "approval.resolved",
  "user-input.requested",
  "user-input.resolved",
]);

function activityDetail(activity: OrchestrationThreadActivity): string | null {
  if (typeof activity.payload !== "object" || activity.payload === null) {
    return null;
  }
  const detail = (activity.payload as Record<string, unknown>).detail;
  return typeof detail === "string" ? detail.toLowerCase() : null;
}

function resolvesStaleApproval(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "provider.approval.respond.failed") {
    return false;
  }
  const detail = activityDetail(activity);
  return (
    detail !== null &&
    (detail.includes("stale pending approval request") ||
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request"))
  );
}

function resolvesStaleUserInput(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "provider.user-input.respond.failed") {
    return false;
  }
  const detail = activityDetail(activity);
  return (
    detail !== null &&
    (detail.includes("stale pending user-input request") ||
      detail.includes("unknown pending user-input request") ||
      detail.includes("unknown pending user input request") ||
      detail.includes("unknown pending codex user input request"))
  );
}

/** Whether an activity can change a field in `OrchestrationThreadShell`. */
export function isShellSummaryActivity(activity: OrchestrationThreadActivity): boolean {
  return (
    SHELL_SUMMARY_ACTIVITY_KINDS.has(activity.kind) ||
    resolvesStaleApproval(activity) ||
    resolvesStaleUserInput(activity)
  );
}

/**
 * Classifies thread events by whether their completed projection can change the
 * shell. Keep this shared with the thread projector: advancing a persisted
 * cursor past a misclassified event would make a cached shell skip that change.
 */
export function isShellVisibleThreadEvent(event: OrchestrationEvent): boolean {
  switch (event.type) {
    case "thread.created":
    case "thread.deleted":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.settled":
    case "thread.unsettled":
    case "thread.snoozed":
    case "thread.unsnoozed":
    case "thread.pinned":
    case "thread.unpinned":
    case "thread.pin-reordered":
    case "thread.meta-updated":
    case "thread.runtime-mode-set":
    case "thread.interaction-mode-set":
    case "thread.turn-interrupt-requested":
    case "thread.approval-response-requested":
    case "thread.reverted":
    case "thread.history-pruned":
    case "thread.session-set":
    case "thread.proposed-plan-upserted":
    case "thread.turn-diff-completed":
      return true;

    case "thread.message-sent":
      return event.payload.role === "user" || !event.payload.streaming;

    case "thread.activity-appended":
      return isShellSummaryActivity(event.payload.activity);

    case "project.created":
    case "project.meta-updated":
    case "project.deleted":
    case "provider.usage-limits-updated":
    case "thread.message-queued":
    case "thread.queued-message-deleted":
    case "thread.queued-message-dispatched":
    case "thread.turn-start-requested":
    case "thread.user-input-response-requested":
    case "thread.checkpoint-revert-requested":
    case "thread.history-prune-requested":
    case "thread.session-stop-requested":
      return false;
  }
}

export function isShellVisibleEvent(event: OrchestrationEvent): boolean {
  return event.aggregateKind === "thread" ? isShellVisibleThreadEvent(event) : true;
}
