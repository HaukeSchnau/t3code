import { describe, expect, it } from "vite-plus/test";

import {
  filterWorkspaceGroups,
  groupThreadsByWorkspace,
  type WorkspaceThread,
} from "./workspaces.ts";

const thread = (overrides: Partial<WorkspaceThread>): WorkspaceThread => ({
  environmentId: "env",
  projectId: "project",
  worktreePath: "/w/fix-login",
  branch: null,
  settled: false,
  running: false,
  updatedAtMs: 0,
  ...overrides,
});

describe("workspace groups", () => {
  it("groups threads by environment, project and path, running workspaces first", () => {
    const groups = groupThreadsByWorkspace([
      thread({ worktreePath: "/w/fix-login", updatedAtMs: 5 }),
      thread({ worktreePath: "/w/fix-login", running: true, settled: true }),
      thread({ worktreePath: "/w/docs", updatedAtMs: 9 }),
      thread({ worktreePath: "/w/docs", projectId: "other" }),
      thread({ worktreePath: null }),
    ]);
    expect(
      groups.map((group) => [group.label, group.threadCount, group.runningCount, group.settled]),
    ).toEqual([
      ["fix-login", 2, 1, false],
      ["docs", 1, 0, false],
      ["docs", 1, 0, false],
    ]);
  });

  it("hides settled workspaces unless shown or searched for", () => {
    const groups = groupThreadsByWorkspace([
      thread({ worktreePath: "/w/fix-login", settled: true }),
      thread({ worktreePath: "/w/docs" }),
    ]);
    const labels = (options: { query: string; showSettled: boolean }) =>
      filterWorkspaceGroups(groups, options).map((group) => group.label);
    expect(labels({ query: "", showSettled: false })).toEqual(["docs"]);
    expect(labels({ query: "", showSettled: true })).toEqual(["fix-login", "docs"]);
    expect(labels({ query: "LOGIN", showSettled: false })).toEqual(["fix-login"]);
  });
});
