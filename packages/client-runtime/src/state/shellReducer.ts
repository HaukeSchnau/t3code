import type { OrchestrationShellSnapshot, OrchestrationShellStreamEvent } from "@t3tools/contracts";

function upsertBy<T>(
  values: ReadonlyArray<T>,
  value: T,
  matches: (candidate: T) => boolean,
): ReadonlyArray<T> {
  const index = values.findIndex(matches);
  if (index < 0) {
    return [...values, value];
  }
  if (values[index] === value) {
    return values;
  }
  const next = [...values];
  next[index] = value;
  return next;
}

/**
 * Reduce a single shell stream event into an existing snapshot, returning a new
 * snapshot with the event's changes applied. This is a pure reducer that both
 * web and mobile can use to keep their local shell snapshot in sync.
 *
 * Returns the original snapshot reference unchanged if the event is not
 * recognized (forward-compatible).
 */
export function applyShellStreamEvent(
  snapshot: OrchestrationShellSnapshot,
  event: OrchestrationShellStreamEvent,
): OrchestrationShellSnapshot {
  if (event.sequence <= snapshot.snapshotSequence) return snapshot;

  switch (event.kind) {
    case "project-upserted": {
      const projects = upsertBy(
        snapshot.projects,
        event.project,
        (project) => project.id === event.project.id,
      );
      return { ...snapshot, projects, snapshotSequence: event.sequence };
    }
    case "project-removed":
      return {
        ...snapshot,
        projects: snapshot.projects.filter((project) => project.id !== event.projectId),
        snapshotSequence: event.sequence,
      };
    case "thread-upserted": {
      const threads = upsertBy(
        snapshot.threads,
        event.thread,
        (thread) => thread.id === event.thread.id,
      );
      return { ...snapshot, threads, snapshotSequence: event.sequence };
    }
    case "thread-removed":
      return {
        ...snapshot,
        threads: snapshot.threads.filter((thread) => thread.id !== event.threadId),
        snapshotSequence: event.sequence,
      };
    case "usage-limits-updated": {
      const current = snapshot.usageLimits.find(
        (entry) => entry.providerInstanceId === event.usageLimits.providerInstanceId,
      );
      const nextUsageLimits =
        current?.history !== undefined && event.usageLimits.history === undefined
          ? { ...event.usageLimits, history: current.history }
          : event.usageLimits;
      const usageLimits = upsertBy(
        snapshot.usageLimits,
        nextUsageLimits,
        (entry) => entry.providerInstanceId === event.usageLimits.providerInstanceId,
      );
      return { ...snapshot, usageLimits, snapshotSequence: event.sequence };
    }
    default:
      return snapshot;
  }
}
