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
  buildSidebarOrchestrationItems,
  buildThreadLineage,
  coordinationCountsLabel,
  countWorkers,
  groupChildrenByEffort,
  openWaitsCovering,
  orderEffortGroups,
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

  it("keeps fork creation ownership separate from its source", () => {
    const lineage = buildThreadLineage([
      coordination({
        relationships: [
          { kind: "createdBy", actor: ref("caller"), target: ref("fork"), createdAt: at(1) },
          { kind: "forkedFrom", actor: ref("source"), target: ref("fork"), createdAt: at(1) },
        ],
      }),
    ]);
    expect(lineage.entries.get(key("fork"))).toMatchObject({
      parentKey: key("caller"),
      forkedFromKey: key("source"),
    });
  });

  it("represents a self-fork with distinct creation and source facts", () => {
    const lineage = buildThreadLineage([
      coordination({
        relationships: [
          { kind: "createdBy", actor: ref("caller"), target: ref("fork"), createdAt: at(1) },
          { kind: "forkedFrom", actor: ref("caller"), target: ref("fork"), createdAt: at(1) },
        ],
      }),
    ]);
    expect(lineage.entries.get(key("fork"))).toMatchObject({
      parentKey: key("caller"),
      forkedFromKey: key("caller"),
    });
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

  it("places an explicit effort member under its coordinator instead of its fork source", () => {
    const effortId = ThreadOrchestrationEffortId.make("effort-prototype");
    const lineage = buildThreadLineage([
      coordination({
        relationships: [
          { kind: "forkedFrom", actor: ref("source"), target: ref("fork"), createdAt: at(1) },
        ],
        efforts: [
          {
            effortId,
            coordinator: ref("coord"),
            title: "Prototype",
            members: [{ thread: ref("fork"), label: "Prototype", joinedAt: at(2) }],
            openedAt: at(0),
            closedAt: null,
          },
        ],
      }),
    ]);
    const layout = resolveSidebarLineage(
      lineage,
      new Set([key("coord"), key("source"), key("fork")]),
    );
    expect(layout.childrenByParentKey.get(key("coord"))).toEqual([key("fork")]);
    expect(layout.childrenByParentKey.get(key("source"))).toBeUndefined();
    expect(groupChildrenByEffort(lineage, key("coord"), [key("fork")])).toMatchObject([
      { effort: { effortId }, memberKeys: [key("fork")] },
    ]);
  });

  it("renders a cross-lineage effort member once under the effort coordinator", () => {
    const effortId = ThreadOrchestrationEffortId.make("effort-cross-lineage");
    const lineage = buildThreadLineage([
      coordination({
        relationships: [
          { kind: "createdBy", actor: ref("creator"), target: ref("worker"), createdAt: at(1) },
        ],
        efforts: [
          {
            effortId,
            coordinator: ref("coord"),
            title: "Cross-lineage review",
            members: [{ thread: ref("worker"), label: "Reviewer", joinedAt: at(2) }],
            openedAt: at(0),
            closedAt: null,
          },
        ],
      }),
    ]);
    const layout = resolveSidebarLineage(
      lineage,
      new Set([key("creator"), key("coord"), key("worker")]),
    );
    expect(layout.childrenByParentKey.get(key("coord"))).toEqual([key("worker")]);
    expect(layout.childrenByParentKey.get(key("creator"))).toBeUndefined();
    expect([...layout.nestedKeys]).toEqual([key("worker")]);
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

  it("orders current work before completed and closed efforts without time-based sorting", () => {
    const completedEffort = ThreadOrchestrationEffortId.make("effort-completed");
    const activeEffort = ThreadOrchestrationEffortId.make("effort-active");
    const closedEffort = ThreadOrchestrationEffortId.make("effort-closed");
    const lineage = buildThreadLineage([
      coordination({
        relationships: [
          { kind: "createdBy", actor: ref("coord"), target: ref("done"), createdAt: at(1) },
          { kind: "createdBy", actor: ref("coord"), target: ref("active"), createdAt: at(2) },
          { kind: "createdBy", actor: ref("coord"), target: ref("closed"), createdAt: at(3) },
        ],
        efforts: [
          {
            effortId: completedEffort,
            coordinator: ref("coord"),
            title: "Completed",
            members: [{ thread: ref("done"), label: "Done", joinedAt: at(1) }],
            openedAt: at(0),
            closedAt: null,
          },
          {
            effortId: activeEffort,
            coordinator: ref("coord"),
            title: "Active",
            members: [{ thread: ref("active"), label: "Active", joinedAt: at(2) }],
            openedAt: at(1),
            closedAt: null,
          },
          {
            effortId: closedEffort,
            coordinator: ref("coord"),
            title: "Closed",
            members: [{ thread: ref("closed"), label: "Closed", joinedAt: at(3) }],
            openedAt: at(2),
            closedAt: at(4),
          },
        ],
      }),
    ]);
    const groups = groupChildrenByEffort(lineage, key("coord"), [
      key("done"),
      key("active"),
      key("closed"),
    ]);
    const states = new Map([
      [key("done"), "completed" as const],
      [key("active"), "blocked" as const],
      [key("closed"), "completed" as const],
    ]);
    expect(
      orderEffortGroups(lineage, groups, (threadKey) => states.get(threadKey) ?? null).map(
        (group) => group.effort?.effortId,
      ),
    ).toEqual([activeEffort, completedEffort, closedEffort]);
  });

  it("ranks an effort by attention in its rendered nested subtree", () => {
    const idleEffort = ThreadOrchestrationEffortId.make("effort-idle");
    const nestedAttentionEffort = ThreadOrchestrationEffortId.make("effort-nested-attention");
    const lineage = buildThreadLineage([
      coordination({
        relationships: [
          { kind: "createdBy", actor: ref("coord"), target: ref("idle"), createdAt: at(1) },
          { kind: "createdBy", actor: ref("coord"), target: ref("done"), createdAt: at(2) },
          { kind: "createdBy", actor: ref("done"), target: ref("blocked"), createdAt: at(3) },
        ],
        efforts: [
          {
            effortId: idleEffort,
            coordinator: ref("coord"),
            title: "Idle",
            members: [{ thread: ref("idle"), label: "Idle", joinedAt: at(1) }],
            openedAt: at(0),
            closedAt: null,
          },
          {
            effortId: nestedAttentionEffort,
            coordinator: ref("coord"),
            title: "Nested attention",
            members: [{ thread: ref("done"), label: "Done", joinedAt: at(2) }],
            openedAt: at(1),
            closedAt: null,
          },
        ],
      }),
    ]);
    const states = new Map([
      [key("idle"), "idle" as const],
      [key("done"), "completed" as const],
      [key("blocked"), "blocked" as const],
    ]);
    const groups = groupChildrenByEffort(lineage, key("coord"), [key("idle"), key("done")]);

    expect(
      orderEffortGroups(lineage, groups, (threadKey) => states.get(threadKey) ?? null).map(
        (group) => group.effort?.effortId,
      ),
    ).toEqual([nestedAttentionEffort, idleEffort]);

    const model = buildSidebarOrchestrationItems({
      lineage,
      orderedThreadKeys: [key("coord"), key("idle"), key("done"), key("blocked")],
      isExpanded: (containerId) => containerId.startsWith("lineage:"),
      stateOf: (threadKey) => states.get(threadKey) ?? null,
    });
    const sections = model.items.filter((item) => item.type === "section");
    expect(sections.map((item) => item.title)).toEqual(["Nested attention", "Idle"]);
    expect(sections[0]).toMatchObject({
      attention: true,
      summary: "1 needs you · 1 done · 2 hidden",
    });
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
    expect(coordinationCountsLabel(counts)).toBe("1 needs you · 1 working · 1 done");
  });
});

describe("buildSidebarOrchestrationItems", () => {
  const lineage = buildThreadLineage([SAMPLE]);
  const orderedKeys = [
    key("coord"),
    key("research"),
    key("impl"),
    key("impl-retry"),
    key("impl-page"),
    key("ghostty"),
    key("unrelated"),
  ];
  const states = new Map([
    [key("coord"), "idle" as const],
    [key("research"), "completed" as const],
    [key("impl"), "failed" as const],
    [key("impl-retry"), "blocked" as const],
    [key("impl-page"), "working" as const],
    [key("ghostty"), "working" as const],
    [key("unrelated"), "idle" as const],
  ]);

  it("keeps leaves top-level and collapses the complete recursive root subtree", () => {
    const model = buildSidebarOrchestrationItems({
      lineage,
      orderedThreadKeys: orderedKeys,
      selectedThreadKey: key("impl-page"),
      isExpanded: () => false,
      stateOf: (threadKey) => states.get(threadKey) ?? null,
    });

    expect(model.items.map((item) => item.type)).toEqual(["thread", "viewing", "thread"]);
    const root = model.items[0];
    expect(root).toMatchObject({
      type: "thread",
      threadKey: key("coord"),
      depth: 0,
      lineageContainer: {
        id: `lineage:${key("coord")}`,
        root: true,
        summary: "1 needs you · 2 working · 1 done · 5 hidden",
      },
    });
    expect(model.items[1]).toMatchObject({
      type: "viewing",
      threadKey: key("impl-page"),
      containerIds: [`lineage:${key("coord")}`, `effort:${EFFORT}`, `lineage:${key("impl-retry")}`],
    });
    expect(model.items[2]).toMatchObject({ type: "thread", threadKey: key("unrelated") });
  });

  it.each([
    { pinned: new Set([key("child")]), ordered: [key("child"), key("root")] },
    { pinned: new Set([key("root")]), ordered: [key("root"), key("child")] },
  ])("splits hierarchy at a pin boundary without duplicating rows", ({ pinned, ordered }) => {
    const boundaryLineage = buildThreadLineage([
      coordination({
        relationships: [
          { kind: "createdBy", actor: ref("root"), target: ref("child"), createdAt: at(1) },
        ],
      }),
    ]);
    const model = buildSidebarOrchestrationItems({
      lineage: boundaryLineage,
      orderedThreadKeys: ordered,
      isExpanded: () => true,
      stateOf: () => "idle",
      isPinned: (threadKey) => pinned.has(threadKey),
    });
    const rows = model.items.filter((item) => item.type === "thread");

    expect(rows.map((item) => item.threadKey)).toEqual(ordered);
    expect(rows.every((item) => item.depth === 0 && item.lineageContainer === null)).toBe(true);
  });

  it("shows one canonical retry row and keeps its earlier attempt independently collapsible", () => {
    const model = buildSidebarOrchestrationItems({
      lineage,
      orderedThreadKeys: orderedKeys,
      selectedThreadKey: key("impl"),
      isExpanded: (containerId) => !containerId.startsWith("attempts:"),
      stateOf: (threadKey) => states.get(threadKey) ?? null,
    });

    const threads = model.items.filter((item) => item.type === "thread");
    expect(threads.filter((item) => item.threadKey === key("impl-retry"))).toHaveLength(1);
    expect(threads.filter((item) => item.threadKey === key("impl"))).toHaveLength(0);
    expect(
      model.items.find((item) => item.type === "viewing" && item.threadKey === key("impl")),
    ).toMatchObject({ containerIds: expect.arrayContaining([`attempts:${key("impl-retry")}`]) });

    const expanded = buildSidebarOrchestrationItems({
      lineage,
      orderedThreadKeys: orderedKeys,
      isExpanded: () => true,
      stateOf: (threadKey) => states.get(threadKey) ?? null,
    });
    expect(
      expanded.items.filter((item) => item.type === "thread" && item.threadKey === key("impl")),
    ).toHaveLength(1);
  });

  it("suppresses an earlier attempt when its replacement is outside the live inbox", () => {
    const model = buildSidebarOrchestrationItems({
      lineage,
      orderedThreadKeys: [key("impl"), key("unrelated")],
      isExpanded: () => true,
      stateOf: (threadKey) => states.get(threadKey) ?? null,
    });

    expect(model.items.flatMap((item) => (item.type === "thread" ? [item.threadKey] : []))).toEqual(
      [key("unrelated")],
    );
  });

  it("keeps a closed effort current while it still has visible work", () => {
    const currentEffort = ThreadOrchestrationEffortId.make("effort-closed-current");
    const pastEffort = ThreadOrchestrationEffortId.make("effort-closed-past");
    const closedLineage = buildThreadLineage([
      coordination({
        relationships: [
          { kind: "createdBy", actor: ref("coord"), target: ref("active"), createdAt: at(1) },
          { kind: "createdBy", actor: ref("coord"), target: ref("settled"), createdAt: at(2) },
        ],
        efforts: [
          {
            effortId: currentEffort,
            coordinator: ref("coord"),
            title: "Closed but active",
            members: [{ thread: ref("active"), label: "Active", joinedAt: at(1) }],
            openedAt: at(0),
            closedAt: at(3),
          },
          {
            effortId: pastEffort,
            coordinator: ref("coord"),
            title: "Past",
            members: [{ thread: ref("settled"), label: "Settled", joinedAt: at(2) }],
            openedAt: at(1),
            closedAt: at(4),
          },
        ],
      }),
    ]);
    const model = buildSidebarOrchestrationItems({
      lineage: closedLineage,
      orderedThreadKeys: [key("coord"), key("active")],
      isExpanded: () => true,
      stateOf: (threadKey) => (threadKey === key("active") ? "working" : "idle"),
    });

    expect(
      model.items.map((item) =>
        item.type === "thread" ? item.threadKey : "title" in item ? item.title : item.type,
      ),
    ).toEqual([key("coord"), "Closed but active", key("active"), "Past efforts", "Past"]);
    expect(
      model.items.find((item) => item.type === "section" && item.title === "Closed but active"),
    ).toMatchObject({ closed: true, summary: "1 working · 1 hidden" });
  });

  it("evaluates each worker once for a 1,000-thread expanded lineage", () => {
    const threadIds = Array.from({ length: 1_000 }, (_, index) => `deep-${index}`);
    const deepLineage = buildThreadLineage([
      coordination({
        relationships: threadIds.slice(1).map((threadId, index) => ({
          kind: "createdBy" as const,
          actor: ref(threadIds[index]!),
          target: ref(threadId),
          createdAt: at(1),
        })),
      }),
    ]);
    let stateCalls = 0;
    const model = buildSidebarOrchestrationItems({
      lineage: deepLineage,
      orderedThreadKeys: threadIds.map((threadId) => key(threadId)),
      isExpanded: () => true,
      stateOf: () => {
        stateCalls += 1;
        return "working";
      },
    });

    expect(model.items.filter((item) => item.type === "thread")).toHaveLength(1_000);
    expect(stateCalls).toBe(1_000);
  });
});
