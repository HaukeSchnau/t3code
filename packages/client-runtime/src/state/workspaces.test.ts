import { describe, expect, it } from "vite-plus/test";

import {
  filterWorkspaceGroups,
  groupThreadsByWorkspace,
  managedWorkspacesForProject,
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

describe("managedWorkspacesForProject", () => {
  const capability = { isolated: true };
  const config = {
    environment: { capabilities: { managedWorkspaces: capability } },
    scratchWorkspaceRoot: "/home/me/.t3/scratch",
  };
  const forProject = (projectRoot: string, vcsKind: "git" | "jj" | undefined) =>
    managedWorkspacesForProject({ config, projectRoot, vcsKind });

  it("leaves plain Git projects to upstream's worktree flow", () => {
    expect(forProject("/code/app", "git")).toBeNull();
  });

  it("offers managed workspaces for jj and non-Git projects", () => {
    expect(forProject("/code/app", "jj")).toBe(capability);
    // A folder without a repository, or a status that has not loaded yet.
    expect(forProject("/code/notes", undefined)).toBe(capability);
  });

  it("offers none for scratch threads or servers without the capability", () => {
    expect(forProject("/home/me/.t3/scratch", undefined)).toBeNull();
    expect(
      managedWorkspacesForProject({
        config: { environment: { capabilities: {} } },
        projectRoot: "/code/app",
        vcsKind: "jj",
      }),
    ).toBeNull();
  });
});
