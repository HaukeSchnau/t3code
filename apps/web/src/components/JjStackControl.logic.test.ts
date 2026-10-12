import { buildJjStackView } from "@t3tools/client-runtime/state/vcs";
import type { JjStackEntry, JjStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { jjActionToast, jjRowActions, jjStackActions } from "./JjStackControl.logic";

const entry = (changeId: string, overrides: Partial<JjStackEntry> = {}): JjStackEntry => ({
  changeId,
  commitId: `${changeId}-commit`,
  description: "",
  empty: false,
  conflict: false,
  workingCopy: false,
  bookmarks: [],
  pushed: false,
  threadId: null,
  turns: [],
  flags: [],
  ...overrides,
});

const view = (stack: ReadonlyArray<JjStackEntry>) => {
  const status: JjStatus = {
    operationId: "op",
    trunk: { changeId: "trunk", label: "main@origin" },
    stack,
    conflictedFiles: [],
    unattributed: [],
  };
  return buildJjStackView(status, null);
};

const actionFor = (actions: ReturnType<typeof jjStackActions>, label: string) =>
  actions.find((candidate) => candidate.label === label);

describe("jjRowActions", () => {
  it("squashes only changes whose parent is in the stack, and edits only other changes", () => {
    const stack = view([entry("wc", { workingCopy: true }), entry("middle"), entry("oldest")]);
    const [workingCopy, middle, oldest] = stack.rows;

    expect(jjRowActions(stack, workingCopy!)).toEqual({ squash: true, edit: false });
    expect(jjRowActions(stack, middle!)).toEqual({ squash: true, edit: true });
    expect(jjRowActions(stack, oldest!)).toEqual({ squash: false, edit: true });
  });
});

describe("jjStackActions", () => {
  it("pushes the change below an empty working copy", () => {
    const actions = jjStackActions(
      view([entry("wc", { workingCopy: true, empty: true }), entry("feature")]),
      true,
    );

    expect(actionFor(actions, "Push")).toMatchObject({
      action: { _tag: "push", changeId: "feature" },
      disabled: false,
    });
    expect(actionFor(actions, "Create PR")?.action).toEqual({ _tag: "pr", changeId: "feature" });
    expect(actionFor(actions, "Absorb")?.disabled).toBe(true);
  });

  it("disables push without a change to push and rebase without a trunk", () => {
    const actions = jjStackActions(view([entry("wc", { workingCopy: true, empty: true })]), false);

    expect(actionFor(actions, "Push")).toMatchObject({ action: { _tag: "push" }, disabled: true });
    expect(actionFor(actions, "Rebase onto trunk")?.disabled).toBe(true);
  });
});

describe("jjActionToast", () => {
  it("warns when the action left conflicts", () => {
    expect(jjActionToast({ summary: "Fetched", conflictedChanges: [] })).toEqual({
      type: "success",
      title: "Fetched",
    });
    expect(
      jjActionToast({ summary: "Rebased the stack onto trunk", conflictedChanges: ["a", "b"] }),
    ).toEqual({
      type: "warning",
      title: "Rebased the stack onto trunk",
      description: "2 changes now have conflicts.",
    });
  });
});
