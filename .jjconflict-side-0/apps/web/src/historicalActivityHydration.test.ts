import { EventId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  acceptHydratedHistoricalTurn,
  hydratedHistoricalTurnIsCurrent,
  mergeUniqueThreadActivities,
} from "./historicalActivityHydration";

const threadId = ThreadId.make("thread-1");
const turnId = TurnId.make("turn-1");
const metadata = {
  id: EventId.make("activity-1"),
  tone: "tool" as const,
  kind: "tool.completed",
  summary: "Ran tests",
  turnId,
  sequence: 7,
  createdAt: "2026-07-17T12:00:00.000Z",
};
const group = {
  turnId,
  revision: 7,
  activityCount: 1,
  payloadBytes: 128,
  displayActivityCount: 1,
  firstActivityAt: metadata.createdAt,
  lastActivityAt: metadata.createdAt,
};

describe("historical activity hydration", () => {
  it("accepts a lossless response only when it exactly matches the current metadata group", () => {
    const accepted = acceptHydratedHistoricalTurn({
      threadId,
      group,
      snapshot: {
        snapshotSequence: 12,
        threadId,
        turnId,
        revision: 7,
        payloadBytes: 128,
        activities: [{ ...metadata, payload: { output: "full output" } }],
      },
    });

    expect(accepted?.activities[0]?.payload).toEqual({ output: "full output" });
    expect(hydratedHistoricalTurnIsCurrent(group, accepted ?? undefined)).toBe(true);
  });

  it("rejects a response when a prune changed the base group while the request was running", () => {
    const accepted = acceptHydratedHistoricalTurn({
      threadId,
      group: { ...group, revision: 8 },
      snapshot: {
        snapshotSequence: 12,
        threadId,
        turnId,
        revision: 7,
        payloadBytes: 128,
        activities: [{ ...metadata, payload: { output: "stale" } }],
      },
    });

    expect(accepted).toBeNull();
  });

  it("invalidates a memory cache entry when the server revision changes", () => {
    const cached = {
      revision: 7,
      payloadBytes: 128,
      activities: [{ ...metadata, payload: {} }],
    };
    expect(hydratedHistoricalTurnIsCurrent({ ...group, revision: 8 }, cached)).toBe(false);
  });

  it("uses revision and count for validity instead of cross-runtime payload size estimates", () => {
    const accepted = acceptHydratedHistoricalTurn({
      threadId,
      group: { ...group, payloadBytes: 4 },
      snapshot: {
        snapshotSequence: 12,
        threadId,
        turnId,
        revision: 7,
        payloadBytes: 18,
        activities: [{ ...metadata, payload: { output: "Grüße 👋" } }],
      },
    });

    expect(accepted).not.toBeNull();
    expect(hydratedHistoricalTurnIsCurrent(group, accepted ?? undefined)).toBe(true);
    expect(
      hydratedHistoricalTurnIsCurrent({ ...group, activityCount: 2 }, accepted ?? undefined),
    ).toBe(false);
  });

  it("combines globally hot semantic rows with disjoint hydrated fold activities", () => {
    const plan = {
      ...metadata,
      kind: "turn.plan.updated" as const,
      summary: "Updated plan",
      payload: { plan: "hot" },
    };
    const subagent = {
      ...metadata,
      id: EventId.make("subagent-1"),
      kind: "subagent.thread" as const,
      summary: "Subagent",
      payload: {},
    };
    const hydratedFoldActivity = {
      ...metadata,
      id: EventId.make("fold-activity"),
      payload: { output: "hydrated" },
    };

    expect(mergeUniqueThreadActivities([plan, subagent], [hydratedFoldActivity])).toEqual([
      plan,
      subagent,
      hydratedFoldActivity,
    ]);
  });

  it("defensively prefers hot state if malformed hydration overlaps by id", () => {
    const hot = { ...metadata, payload: { source: "hot" } };
    const overlapping = { ...metadata, payload: { source: "hydrated" } };
    const combined = mergeUniqueThreadActivities([hot], [overlapping]);

    expect(combined).toEqual([hot]);
  });
});
