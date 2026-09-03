import { describe, expect, it, vi } from "vitest";
import { CommandId, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import { openWorkspaceInApp } from "./openWorkspaceInApp";

const ENVIRONMENT_ID = EnvironmentId.make("env-local");

function makeInput(overrides: Partial<Parameters<typeof openWorkspaceInApp>[0]> = {}) {
  return {
    environmentId: ENVIRONMENT_ID,
    environmentPlatform: "MacIntel",
    rawCwd: "/repo",
    currentProjectCwd: null,
    projects: [],
    threads: [],
    sidebarThreadSortOrder: "updated_at" as const,
    defaultThreadEnvMode: "local" as const,
    newCommandId: vi.fn(() => CommandId.make("command-1")),
    newProjectId: vi.fn(() => ProjectId.make("project-new")),
    dispatchCreateProject: vi.fn(async () => undefined),
    handleNewThread: vi.fn(async () => undefined),
    navigateToThread: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("openWorkspaceInApp", () => {
  it("navigates to the latest active thread for an existing project", async () => {
    const input = makeInput({
      projects: [
        { id: ProjectId.make("project-1"), environmentId: ENVIRONMENT_ID, workspaceRoot: "/repo" },
      ],
      threads: [
        {
          id: ThreadId.make("thread-old"),
          environmentId: ENVIRONMENT_ID,
          projectId: ProjectId.make("project-1"),
          archivedAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: ThreadId.make("thread-new"),
          environmentId: ENVIRONMENT_ID,
          projectId: ProjectId.make("project-1"),
          archivedAt: null,
          createdAt: "2026-01-02T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
    });

    await expect(openWorkspaceInApp(input)).resolves.toBe("opened-existing-thread");

    expect(input.navigateToThread).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      threadId: "thread-new",
    });
    expect(input.dispatchCreateProject).not.toHaveBeenCalled();
    expect(input.handleNewThread).not.toHaveBeenCalled();
  });

  it("opens a draft thread for an existing project without active threads", async () => {
    const input = makeInput({
      projects: [
        { id: ProjectId.make("project-1"), environmentId: ENVIRONMENT_ID, workspaceRoot: "/repo" },
      ],
      threads: [
        {
          id: ThreadId.make("thread-archived"),
          environmentId: ENVIRONMENT_ID,
          projectId: ProjectId.make("project-1"),
          archivedAt: "2026-01-03T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    await expect(openWorkspaceInApp(input)).resolves.toBe("opened-existing-project");

    expect(input.handleNewThread).toHaveBeenCalledWith(
      { environmentId: ENVIRONMENT_ID, projectId: "project-1" },
      { envMode: "local" },
    );
    expect(input.dispatchCreateProject).not.toHaveBeenCalled();
  });

  it("creates a project and opens a draft thread for a new workspace", async () => {
    const input = makeInput();

    await expect(openWorkspaceInApp(input)).resolves.toBe("created-project");

    expect(input.dispatchCreateProject).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "project.create",
        projectId: "project-new",
        workspaceRoot: "/repo",
        title: "repo",
      }),
    );
    expect(input.handleNewThread).toHaveBeenCalledWith(
      { environmentId: ENVIRONMENT_ID, projectId: "project-new" },
      { envMode: "local" },
    );
  });

  it("rejects invalid workspace paths", async () => {
    await expect(
      openWorkspaceInApp(makeInput({ rawCwd: "", environmentPlatform: "MacIntel" })),
    ).rejects.toThrow("Enter a project path.");
    await expect(
      openWorkspaceInApp(makeInput({ rawCwd: "C:\\repo", environmentPlatform: "MacIntel" })),
    ).rejects.toThrow("Windows-style paths are only supported on Windows environments.");
  });
});
