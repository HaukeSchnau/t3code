import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  ThreadOrchestrationEffortId,
  ThreadOrchestrationWaitId,
  ThreadOrchestrationWatchId,
  type OrchestrationCoordinationShell,
} from "@t3tools/contracts";

import { scopedThreadKey } from "../environment/scoped.ts";
import {
  buildThreadLineage,
  coordinationCountsLabel,
  countWorkers,
  groupChildrenByEffort,
  openWaitsCovering,
  resolveSidebarLineage,
  resolveWorkerState,
  rootCoordinatorKey,
  threadParticipatesInCoordination,
  type EnvironmentCoordination,
} from "./threadCoordination.ts";

const ENV = EnvironmentId.make("env-a");
const key = (threadId: string, environmentId: EnvironmentId = ENV) =>
  scopedThreadKey({ environmentId, threadId: ThreadId.make(threadId) });
const ref = (threadId: string) => ({ threadId: ThreadId.make(threadId) });
const at = (minute: number) => `2026-09-02T08:${String(minute).padStart(2, "0")}:00.000Z`;

function coordination(
  overrides: Partial<OrchestrationCoordinationShell> = {},
): EnvironmentCoordination {
  return {
    environmentId: ENV,
    coordination: { relationships: [], efforts: [], waits: [], watches: [], ...overrides },
  };
}

const EFFORT = ThreadOrchestrationEffortId.make("effort-auth");
const WAIT = ThreadOrchestrationWaitId.make("wait-review");
const WATCH = ThreadOrchestrationWatchId.make("watch-deploy");

const SAMPLE = coordination({
  relationships: [
    {
      kind: "createdBy",
      actor: ref("coord"),
      target: ref("research"),
      label: "Research",
      effortId: EFFORT,
      createdAt: at(1),
    },
    {
      kind: "createdBy",
      actor: ref("coord"),
      target: ref("impl"),
      label: "Implementation",
      effortId: EFFORT,
      createdAt: at(2),
    },
    {
      kind: "createdBy",
      actor: ref("coord"),
      target: ref("impl-retry"),
      label: "Implementation (retry)",
      effortId: EFFORT,
      createdAt: at(3),
    },
    { kind: "replaces", actor: ref("impl-retry"), target: ref("impl"), createdAt: at(3) },
    {
      kind: "createdBy",
      actor: ref("coord"),
      target: ref("ghostty"),
      label: "GhosttyKit bump",
      createdAt: at(4),
    },
    {
      kind: "createdBy",
      actor: ref("impl-retry"),
      target: ref("impl-page"),
      label: "Page",
      effortId: EFFORT,
      createdAt: at(5),
    },
    { kind: "forkedFrom", actor: ref("coord"), target: ref("fork"), createdAt: at(6) },
  ],
  efforts: [
    {
      effortId: EFFORT,
      coordinator: ref("coord"),
      title: "Auth migration",
      members: [
        { thread: ref("research"), label: "Research", joinedAt: at(1) },
        { thread: ref("impl"), label: "Implementation", joinedAt: at(2) },
        { thread: ref("impl-retry"), label: "Implementation (retry)", joinedAt: at(3) },
      ],
      openedAt: at(0),
      closedAt: null,
    },
  ],
  waits: [
    {
      waitId: WAIT,
      coordinator: ref("coord"),
      effortId: EFFORT,
      members: [{ thread: ref("impl-retry"), outcome: "running" }],
      mode: "all",
      state: "open",
      openedAt: at(3),
      deadlineAt: null,
      resolvedAt: null,
    },
  ],
  watches: [
    {
      watchId: WATCH,
      coordinator: ref("coord"),
      source: { type: "websocket", url: "wss://deploy.example/events" },
      policy: { type: "always" },
      state: "open",
      generation: 1,
      lastSequence: 0,
      eventCount: 0,
      openedAt: at(4),
      deadlineAt: null,
      lastEventAt: null,
      closedAt: null,
      lastSummary: null,
    },
  ],
});

describe("buildThreadLineage", () => {
  it("nests createdBy targets under their actor and keeps creation order", () => {
    const lineage = buildThreadLineage([SAMPLE]);
    const coord = lineage.entries.get(key("coord"));
    expect(coord?.parentKey).toBeNull();
    expect(coord?.childKeys).toEqual([
      key("research"),
      key("impl"),
      key("impl-retry"),
      key("ghostty"),
    ]);
    expect(lineage.entries.get(key("research"))).toMatchObject({
      parentKey: key("coord"),
      label: "Research",
      effortId: EFFORT,
    });
    expect(lineage.entries.get(key("impl-page"))?.parentKey).toBe(key("impl-retry"));
  });

  it("records replacement in both directions and forks without nesting", () => {
    const lineage = buildThreadLineage([SAMPLE]);
    expect(lineage.entries.get(key("impl"))?.replacedByKey).toBe(key("impl-retry"));
    expect(lineage.entries.get(key("impl-retry"))?.replacesKey).toBe(key("impl"));
    const fork = lineage.entries.get(key("fork"));
    expect(fork?.parentKey).toBeNull();
    expect(fork?.forkedFromKey).toBe(key("coord"));
  });

  it("scopes refs to the carrying environment unless the ref names one", () => {
    const remote = EnvironmentId.make("env-b");
    const lineage = buildThreadLineage([
      coordination({
        relationships: [
          {
            kind: "createdBy",
            actor: ref("coord"),
            target: { environmentId: remote, threadId: ThreadId.make("worker") },
            createdAt: at(1),
          },
        ],
      }),
    ]);
    expect(lineage.entries.get(key("coord"))?.childKeys).toEqual([key("worker", remote)]);
  });

  it("returns the shared empty lineage when no environment coordinates", () => {
    expect(buildThreadLineage([coordination()])).toBe(buildThreadLineage([]));
  });
});

describe("resolveSidebarLineage", () => {
  const lineage = buildThreadLineage([SAMPLE]);
  const all = new Set([
    key("coord"),
    key("research"),
    key("impl"),
    key("impl-retry"),
    key("impl-page"),
    key("ghostty"),
    key("fork"),
    key("unrelated"),
  ]);

  it("nests every child whose parent chain ends in a visible thread", () => {
    const layout = resolveSidebarLineage(lineage, all);
    expect([...layout.nestedKeys].sort()).toEqual(
      [key("research"), key("impl"), key("impl-retry"), key("impl-page"), key("ghostty")].sort(),
    );
    expect(layout.childrenByParentKey.get(key("coord"))).toEqual([
      key("research"),
      key("impl"),
      key("impl-retry"),
      key("ghostty"),
    ]);
    expect(layout.childrenByParentKey.get(key("impl-retry"))).toEqual([key("impl-page")]);
    // Forks and unrelated threads are ordinary top-level rows.
    expect(layout.nestedKeys.has(key("fork"))).toBe(false);
    expect(layout.nestedKeys.has(key("unrelated"))).toBe(false);
  });

  it("keeps a child at the top level when its parent is not visible", () => {
    const withoutCoordinator = new Set(all);
    withoutCoordinator.delete(key("coord"));
    const layout = resolveSidebarLineage(lineage, withoutCoordinator);
    expect(layout.nestedKeys.has(key("research"))).toBe(false);
    // Grandchildren still nest under their own visible parent.
    expect(layout.nestedKeys.has(key("impl-page"))).toBe(true);
  });

  it("is independent of which thread is selected", () => {
    // Selection never enters the layout; the same inputs give the same rows.
    expect(resolveSidebarLineage(lineage, all)).toEqual(
      resolveSidebarLineage(lineage, new Set(all)),
    );
  });
});

describe("groupChildrenByEffort", () => {
  it("groups members by effort in opening order and leaves the rest ungrouped", () => {
    const lineage = buildThreadLineage([SAMPLE]);
    const groups = groupChildrenByEffort(
      lineage,
      key("coord"),
      lineage.entries.get(key("coord"))?.childKeys ?? [],
    );
    expect(groups.map((group) => group.effort?.title ?? null)).toEqual(["Auth migration", null]);
    expect(groups[0]?.memberKeys).toEqual([key("research"), key("impl"), key("impl-retry")]);
    expect(groups[1]?.memberKeys).toEqual([key("ghostty")]);
  });
});

describe("participation, waits and counts", () => {
  const lineage = buildThreadLineage([SAMPLE]);

  it("reports participation for parents, children and coordinators with waits", () => {
    expect(threadParticipatesInCoordination(lineage, key("coord"))).toBe(true);
    expect(threadParticipatesInCoordination(lineage, key("research"))).toBe(true);
    expect(threadParticipatesInCoordination(lineage, key("unrelated"))).toBe(false);
    expect(rootCoordinatorKey(lineage, key("impl-page"))).toBe(key("coord"));
  });

  it("finds the open wait covering a worker", () => {
    expect(openWaitsCovering(lineage, key("impl-retry")).map((wait) => wait.waitId)).toEqual([
      WAIT,
    ]);
    expect(openWaitsCovering(lineage, key("research"))).toEqual([]);
  });

  it("indexes open watches under their coordinator", () => {
    expect(
      lineage.watchesByCoordinatorKey.get(key("coord"))?.map((watch) => watch.watchId),
    ).toEqual([WATCH]);
  });

  it("derives worker state from shell fields", () => {
    const base = {
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      session: null,
      latestTurn: null,
    };
    expect(resolveWorkerState({ ...base, hasPendingApprovals: true })).toBe("blocked");
    expect(resolveWorkerState({ ...base, session: { status: "running" } })).toBe("working");
    expect(
      resolveWorkerState({
        ...base,
        session: { status: "ready" },
        latestTurn: { state: "completed" },
      }),
    ).toBe("completed");
    expect(resolveWorkerState({ ...base, latestTurn: { state: "error" } })).toBe("failed");
    expect(resolveWorkerState({ ...base, latestTurn: { state: "interrupted" } })).toBe("stopped");
    expect(resolveWorkerState(base)).toBe("idle");
  });

  it("skips replaced workers when counting and labels the roll-up", () => {
    const states = new Map([
      [key("research"), "completed" as const],
      [key("impl"), "failed" as const],
      [key("impl-retry"), "blocked" as const],
      [key("ghostty"), "working" as const],
    ]);
    const counts = countWorkers(
      lineage,
      lineage.entries.get(key("coord"))?.childKeys ?? [],
      (k) => states.get(k) ?? null,
    );
    expect(counts).toMatchObject({ total: 3, completed: 1, blocked: 1, working: 1, failed: 0 });
    expect(coordinationCountsLabel(counts)).toBe("1 working · 1 needs you · 1 done");
  });
});
