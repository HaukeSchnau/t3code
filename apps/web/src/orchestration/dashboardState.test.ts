import { describe, expect, it } from "vite-plus/test";

import { MAX_COMPARISON_COLUMNS } from "./comparison";
import {
  fleetSummaryLabel,
  nonEmptyTallyEntries,
  resolveComparisonBatch,
  summarizeFleet,
  toggleComparisonSelection,
} from "./dashboardState";
import { deriveBatchViews, type BatchView, type OrchestrationBatchWire } from "./model";

const NOW = Date.parse("2026-08-31T12:00:00.000Z");

function batchWire(
  batchId: string,
  overrides: {
    readonly status?: OrchestrationBatchWire["barrier"]["status"];
    readonly notifiedAt?: string | null;
    readonly states: readonly OrchestrationBatchWire["members"][number]["state"][];
    readonly createdAt?: string;
  },
): OrchestrationBatchWire {
  return {
    batchId,
    coordinatorEnvironmentId: "env",
    coordinatorThreadId: "coordinator",
    title: batchId,
    intent: null,
    createdAt: overrides.createdAt ?? "2026-08-31T11:00:00.000Z",
    barrier: {
      status: overrides.status ?? "satisfied",
      resolvedAt: null,
      notifiedAt: overrides.notifiedAt ?? null,
      deadlineAt: null,
    },
    members: overrides.states.map((state, index) => ({
      environmentId: "env",
      threadId: `${batchId}-${index}`,
      title: `worker ${index}`,
      role: `role-${index}`,
      state,
      model: null,
      effort: null,
      hostLabel: "host",
      workspaceRoot: "/repo",
      workspaceIsolation: "worktree",
      worktreePath: `/repo-${index}`,
      startedAt: null,
      settledAt: null,
      reason: null,
      summary: null,
      usage: null,
      diffStat: null,
    })),
  };
}

const views = (batches: readonly OrchestrationBatchWire[]): readonly BatchView[] =>
  deriveBatchViews(batches, NOW);

describe("summarizeFleet", () => {
  it("counts a settled-but-unwoken batch as waking", () => {
    const summary = summarizeFleet(
      views([batchWire("a", { status: "open", states: ["completed", "completed"] })]),
    );
    expect(summary.awaitingCoordinator).toBe(1);
    expect(summary.workers).toBe(2);
  });

  it("does not count a batch that still has outstanding members", () => {
    const summary = summarizeFleet(
      views([batchWire("a", { status: "open", states: ["running", "completed"] })]),
    );
    expect(summary.awaitingCoordinator).toBe(0);
    expect(summary.running).toBe(1);
  });
});

describe("fleetSummaryLabel", () => {
  it("omits conditions that are not happening", () => {
    const label = fleetSummaryLabel(
      summarizeFleet(views([batchWire("a", { states: ["completed", "completed"] })])),
    );
    expect(label).toBe("2 workers in 1 batch");
  });

  it("names running, blocked and waking work", () => {
    const label = fleetSummaryLabel(
      summarizeFleet(
        views([
          batchWire("a", { status: "open", states: ["running", "blocked"] }),
          batchWire("b", { status: "open", states: ["completed"] }),
        ]),
      ),
    );
    expect(label).toBe("3 workers in 2 batches · 1 running · 1 blocked · 1 waking");
  });
});

describe("resolveComparisonBatch", () => {
  const batches = views([
    batchWire("live", {
      status: "open",
      states: ["running", "running"],
      createdAt: "2026-08-31T11:30:00.000Z",
    }),
    batchWire("settled", {
      states: ["completed", "completed"],
      createdAt: "2026-08-31T10:00:00.000Z",
    }),
  ]);

  it("honours an explicit pick over the comparable default", () => {
    expect(resolveComparisonBatch(batches, "live")?.batchId).toBe("live");
  });

  it("falls back to the first comparable batch, not the newest one", () => {
    expect(resolveComparisonBatch(batches, null)?.batchId).toBe("settled");
    expect(resolveComparisonBatch(batches, "gone")?.batchId).toBe("settled");
  });

  it("falls back to the newest batch when nothing is comparable", () => {
    const live = views([batchWire("live", { status: "open", states: ["running"] })]);
    expect(resolveComparisonBatch(live, null)?.batchId).toBe("live");
    expect(resolveComparisonBatch([], null)).toBeNull();
  });
});

describe("toggleComparisonSelection", () => {
  it("never removes the last column", () => {
    expect(toggleComparisonSelection(["a"], "a")).toEqual(["a"]);
    expect(toggleComparisonSelection(["a", "b"], "a")).toEqual(["b"]);
  });

  it("refuses to exceed the column cap", () => {
    const full = Array.from({ length: MAX_COMPARISON_COLUMNS }, (_, index) => `arm-${index}`);
    expect(toggleComparisonSelection(full, "extra")).toBe(full);
    expect(toggleComparisonSelection(full.slice(1), "extra")).toEqual([...full.slice(1), "extra"]);
  });
});

describe("nonEmptyTallyEntries", () => {
  it("drops zeroes and leads with what is happening now", () => {
    const [batch] = views([
      batchWire("a", { status: "open", states: ["completed", "blocked", "running", "queued"] }),
    ]);
    expect(nonEmptyTallyEntries(batch!.tally).map((entry) => entry.state)).toEqual([
      "running",
      "blocked",
      "queued",
      "completed",
    ]);
  });
});
