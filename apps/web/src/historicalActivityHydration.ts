import type {
  OrchestrationThreadActivity,
  OrchestrationThreadHistoricalActivityGroup,
  OrchestrationTurnActivitiesSnapshot,
} from "@t3tools/contracts";

export interface HydratedHistoricalTurn {
  readonly revision: number;
  /** Informational response size only; validity is revision + activity count. */
  readonly payloadBytes: number;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}

/**
 * Combine hot and hydrated activity sets. Compact snapshots keep all plan and
 * subagent activities hot while descriptors/hydration exclude them, so the
 * sets are normally disjoint. ID deduplication is a boundary safeguard; the
 * earlier (hot, revision-stamped) source wins if a malformed response overlaps.
 */
export function mergeUniqueThreadActivities(
  ...sources: ReadonlyArray<ReadonlyArray<OrchestrationThreadActivity>>
): OrchestrationThreadActivity[] {
  const seen = new Set<string>();
  return sources.flatMap((source) =>
    source.filter((activity) => {
      if (seen.has(activity.id)) return false;
      seen.add(activity.id);
      return true;
    }),
  );
}

/** Reject responses that raced a prune/revert or belong to another route. */
export function acceptHydratedHistoricalTurn(input: {
  readonly threadId: string;
  readonly group: OrchestrationThreadHistoricalActivityGroup;
  readonly snapshot: OrchestrationTurnActivitiesSnapshot;
}): HydratedHistoricalTurn | null {
  if (
    input.snapshot.threadId !== input.threadId ||
    input.snapshot.turnId !== input.group.turnId ||
    input.snapshot.revision !== input.group.revision ||
    input.snapshot.activities.length !== input.group.activityCount
  ) {
    return null;
  }
  if (input.snapshot.activities.some((activity) => activity.turnId !== input.group.turnId)) {
    return null;
  }
  return {
    revision: input.snapshot.revision,
    payloadBytes: input.snapshot.payloadBytes,
    activities: input.snapshot.activities,
  };
}

export function hydratedHistoricalTurnIsCurrent(
  group: OrchestrationThreadHistoricalActivityGroup,
  hydrated: HydratedHistoricalTurn | undefined,
): hydrated is HydratedHistoricalTurn {
  return (
    hydrated?.revision === group.revision && hydrated.activities.length === group.activityCount
  );
}
