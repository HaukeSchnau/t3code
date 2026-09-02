import { describe, expect, it } from "vitest";

import type { FixtureEvent } from "./model";
import {
  applyFixtureEvent,
  availableLenses,
  countMembers,
  defaultLens,
  openWaitsOf,
  reduceFixtureEvents,
} from "./reducer";
import { COORDINATOR_ID, EFFORT_AUTH, EFFORT_FLAKE, FIXTURE_STEPS } from "./scenario";

const T = (minutes: number) => new Date(Date.UTC(2026, 8, 2, 8, minutes)).toISOString();

function base(): FixtureEvent[] {
  return [
    { type: "project.added", at: T(0), project: { id: "p", title: "p", workspaceRoot: "/p" } },
    {
      type: "thread.created",
      at: T(0),
      thread: {
        id: "coord",
        projectId: "p",
        title: "Coordinator",
        provider: "claude",
        model: "m",
        branch: null,
        worktree: false,
      },
      prompt: "coordinate",
      status: "completed",
    },
    { type: "effort.opened", at: T(1), effortId: "e", coordinatorId: "coord", title: "Effort" },
    {
      type: "thread.created",
      at: T(1),
      thread: {
        id: "a",
        projectId: "p",
        title: "A",
        provider: "codex",
        model: "m",
        branch: null,
        worktree: false,
      },
      prompt: "do a",
      delegation: { parentId: "coord", label: "A", effortId: "e", turnId: "t1" },
    },
    {
      type: "thread.created",
      at: T(1),
      thread: {
        id: "b",
        projectId: "p",
        title: "B",
        provider: "glm",
        model: "m",
        branch: null,
        worktree: false,
      },
      prompt: "do b",
      delegation: { parentId: "coord", label: "B", effortId: "e", turnId: "t1" },
    },
    {
      type: "wait.opened",
      at: T(1),
      waitId: "w",
      threadId: "coord",
      targets: ["a", "b"],
      condition: "all",
    },
  ];
}

function wakes(state: ReturnType<typeof reduceFixtureEvents>, threadId: string) {
  return state.threads[threadId]?.timeline.filter((item) => item.kind === "wake") ?? [];
}

describe("orchestration fixture reducer", () => {
  it("coalesces completions through an all-of wait and wakes once", () => {
    const state = reduceFixtureEvents([
      ...base(),
      { type: "thread.status", at: T(5), threadId: "a", status: "completed" },
      { type: "thread.status", at: T(9), threadId: "b", status: "completed" },
    ]);
    expect(state.waits.w?.status).toBe("satisfied");
    expect(state.waits.w?.resolvedAt).toBe(T(9));
    const coordinatorWakes = wakes(state, "coord");
    expect(coordinatorWakes).toHaveLength(1);
    expect(coordinatorWakes[0]).toMatchObject({ tone: "info", sourceIds: ["a", "b"] });
  });

  it("wakes the parent with attention on failure and lets a replacement inherit the wait", () => {
    const state = reduceFixtureEvents([
      ...base(),
      {
        type: "thread.status",
        at: T(5),
        threadId: "a",
        status: "failed",
        activity: "tests failed",
      },
      {
        type: "thread.created",
        at: T(6),
        thread: {
          id: "a2",
          projectId: "p",
          title: "A retry",
          provider: "claude",
          model: "m",
          branch: null,
          worktree: false,
        },
        prompt: "retry a",
        delegation: { parentId: "coord", label: "A (retry)", effortId: "e", turnId: "t2" },
        replaces: "a",
      },
    ]);
    expect(wakes(state, "coord")[0]).toMatchObject({ tone: "attention", sourceIds: ["a"] });
    expect(state.replacements.a).toBe("a2");
    expect(state.waits.w?.targets).toEqual(["a2", "b"]);
    // The failed thread no longer counts against the effort; its successor does.
    expect(countMembers(state, state.efforts.e?.members ?? [])).toMatchObject({
      total: 2,
      running: 2,
      failed: 0,
    });
    const notes = state.threads.coord?.timeline.filter((item) => item.kind === "note") ?? [];
    expect(notes.at(-1)).toMatchObject({ text: "Replaced A with A (retry)" });
  });

  it("does not treat a parent idling behind its own open wait as settled", () => {
    const state = reduceFixtureEvents([
      ...base(),
      {
        type: "thread.created",
        at: T(2),
        thread: {
          id: "a1",
          projectId: "p",
          title: "A child",
          provider: "codex",
          model: "m",
          branch: null,
          worktree: false,
        },
        prompt: "sub",
        delegation: { parentId: "a", label: "A child", effortId: "e", turnId: "ta" },
      },
      {
        type: "wait.opened",
        at: T(2),
        waitId: "wa",
        threadId: "a",
        targets: ["a1"],
        condition: "all",
      },
      {
        type: "thread.status",
        at: T(3),
        threadId: "a",
        status: "completed",
        activity: "Waiting on child",
      },
      { type: "thread.status", at: T(4), threadId: "b", status: "completed" },
    ]);
    expect(state.waits.w?.status).toBe("open");
    expect(openWaitsOf(state, "a")).toHaveLength(1);
  });

  it("switching a wait to any-of resolves it when a target already finished", () => {
    const state = reduceFixtureEvents([
      ...base(),
      { type: "thread.status", at: T(5), threadId: "a", status: "completed" },
      { type: "wait.changed", at: T(6), waitId: "w", condition: "any" },
    ]);
    expect(state.waits.w?.status).toBe("satisfied");
    expect(wakes(state, "coord")).toHaveLength(1);
  });

  it("closing an effort can stop live members and cancels waits that only cover them", () => {
    const state = reduceFixtureEvents([
      ...base(),
      { type: "effort.closed", at: T(7), effortId: "e", stopMembers: true },
    ]);
    expect(state.threads.a?.status).toBe("stopped");
    expect(state.threads.b?.status).toBe("stopped");
    expect(state.waits.w?.status).toBe("cancelled");
    const reopened = applyFixtureEvent(state, { type: "effort.reopened", at: T(8), effortId: "e" });
    expect(reopened.efforts.e?.closedAt).toBeNull();
  });

  it("moves a member between efforts and records the correction on the coordinator", () => {
    const state = reduceFixtureEvents([
      ...base(),
      { type: "effort.opened", at: T(2), effortId: "e2", coordinatorId: "coord", title: "Other" },
      { type: "effort.member.moved", at: T(3), threadId: "b", effortId: "e2" },
    ]);
    expect(state.efforts.e?.members).toEqual(["a"]);
    expect(state.efforts.e2?.members).toEqual(["b"]);
    expect(state.threads.b?.effortId).toBe("e2");
    expect(state.threads.coord?.timeline.at(-1)).toMatchObject({
      kind: "note",
      text: "Moved B from Effort to Other",
    });
  });

  it("approval requests block and wake, and resolving twice is idempotent", () => {
    const blocked = reduceFixtureEvents([
      ...base(),
      { type: "approval.requested", at: T(5), threadId: "a", text: "Run migration?" },
    ]);
    expect(blocked.threads.a?.status).toBe("blocked-approval");
    expect(wakes(blocked, "coord")[0]).toMatchObject({
      tone: "attention",
      text: "A needs approval",
    });
    const approved = applyFixtureEvent(blocked, {
      type: "approval.resolved",
      at: T(6),
      threadId: "a",
      approved: true,
    });
    expect(approved.threads.a?.status).toBe("running");
    const again = applyFixtureEvent(approved, {
      type: "approval.resolved",
      at: T(7),
      threadId: "a",
      approved: true,
    });
    expect(again.threads.a).toBe(approved.threads.a);
  });

  it("offers lenses from artifacts and defaults to Diff only when every selection has changes", () => {
    const state = reduceFixtureEvents([
      ...base(),
      {
        type: "thread.artifacts",
        at: T(5),
        threadId: "a",
        artifacts: { patch: "diff --git a/x b/x", terminal: { label: "t", lines: [] } },
      },
      {
        type: "thread.artifacts",
        at: T(5),
        threadId: "b",
        artifacts: { preview: { url: "http://localhost:1/", variant: "nav" } },
      },
    ]);
    expect(availableLenses(state, ["a", "b"])).toEqual(["answer", "diff", "preview", "terminal"]);
    expect(defaultLens(state, ["a", "b"])).toBe("answer");
    expect(defaultLens(state, ["a"])).toBe("diff");
  });

  it("replays the scripted scenario into the expected end state", () => {
    const state = reduceFixtureEvents(FIXTURE_STEPS.flatMap((step) => step.events));
    expect(state.efforts[EFFORT_FLAKE]?.closedAt).not.toBeNull();
    expect(state.efforts[EFFORT_AUTH]?.closedAt).toBeNull();
    expect(state.replacements["thread-auth-impl"]).toBe("thread-auth-impl-retry");
    expect(state.waits["wait-review"]?.status).toBe("open");
    expect(state.waits["wait-content"]?.status).toBe("satisfied");
    expect(state.threads["thread-docs-content"]?.status).toBe("running");
    expect(
      openWaitsOf(state, COORDINATOR_ID)
        .map((wait) => wait.id)
        .sort(),
    ).toEqual(["wait-docs", "wait-review"]);
    expect(state.threads["thread-docs-page-remote"]?.effortId).toBe("effort-docs");
  });
});
