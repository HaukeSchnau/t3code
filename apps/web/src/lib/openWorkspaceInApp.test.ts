import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import { openWorkspaceInApp } from "./openWorkspaceInApp.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");

describe("openWorkspaceInApp", () => {
  it("creates a project and opens a new thread when the workspace is new", async () => {
    const createProject = vi.fn().mockResolvedValue(PROJECT_ID);
    const handleNewThread = vi.fn().mockResolvedValue(undefined);
    const navigateToThread = vi.fn().mockResolvedValue(undefined);

    const result = await openWorkspaceInApp({
      environmentId: ENVIRONMENT_ID,
      environmentPlatform: "MacIntel",
      rawCwd: "/repo/new-project",
      projects: [],
      threads: [],
      sidebarThreadSortOrder: "updated_at",
      defaultThreadEnvMode: "local",
      createProject,
      handleNewThread,
      navigateToThread,
    });

    expect(result).toBe("created-project");
    expect(createProject).toHaveBeenCalledWith({
      cwd: "/repo/new-project",
      title: "new-project",
    });
    expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), {
      envMode: "local",
    });
    expect(navigateToThread).not.toHaveBeenCalled();
  });

  it("opens the latest existing thread when the project already exists", async () => {
    const createProject = vi.fn().mockResolvedValue(PROJECT_ID);
    const handleNewThread = vi.fn().mockResolvedValue(undefined);
    const navigateToThread = vi.fn().mockResolvedValue(undefined);

    const result = await openWorkspaceInApp({
      environmentId: ENVIRONMENT_ID,
      environmentPlatform: "MacIntel",
      rawCwd: "/repo/existing-project",
      projects: [{ id: PROJECT_ID, environmentId: ENVIRONMENT_ID, cwd: "/repo/existing-project" }],
      threads: [
        {
          id: THREAD_ID,
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          archivedAt: null,
          updatedAt: "2026-04-20T12:00:00.000Z",
          createdAt: "2026-04-20T11:00:00.000Z",
        },
      ],
      sidebarThreadSortOrder: "updated_at",
      defaultThreadEnvMode: "local",
      createProject,
      handleNewThread,
      navigateToThread,
    });

    expect(result).toBe("opened-existing-thread");
    expect(navigateToThread).toHaveBeenCalledWith(scopeThreadRef(ENVIRONMENT_ID, THREAD_ID));
    expect(createProject).not.toHaveBeenCalled();
    expect(handleNewThread).not.toHaveBeenCalled();
  });

  it("starts a new thread when the project exists but has no threads yet", async () => {
    const createProject = vi.fn().mockResolvedValue(PROJECT_ID);
    const handleNewThread = vi.fn().mockResolvedValue(undefined);
    const navigateToThread = vi.fn().mockResolvedValue(undefined);

    const result = await openWorkspaceInApp({
      environmentId: ENVIRONMENT_ID,
      environmentPlatform: "MacIntel",
      rawCwd: "/repo/existing-project",
      projects: [{ id: PROJECT_ID, environmentId: ENVIRONMENT_ID, cwd: "/repo/existing-project" }],
      threads: [],
      sidebarThreadSortOrder: "updated_at",
      defaultThreadEnvMode: "local",
      createProject,
      handleNewThread,
      navigateToThread,
    });

    expect(result).toBe("opened-existing-project");
    expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), {
      envMode: "local",
    });
    expect(createProject).not.toHaveBeenCalled();
    expect(navigateToThread).not.toHaveBeenCalled();
  });

  it("rejects unsupported relative and windows-style paths", async () => {
    await expect(
      openWorkspaceInApp({
        environmentId: ENVIRONMENT_ID,
        environmentPlatform: "MacIntel",
        rawCwd: ".",
        projects: [],
        threads: [],
        sidebarThreadSortOrder: "updated_at",
        defaultThreadEnvMode: "local",
        createProject: vi.fn(),
        handleNewThread: vi.fn(),
        navigateToThread: vi.fn(),
      }),
    ).rejects.toThrow("Relative paths require an active project.");

    await expect(
      openWorkspaceInApp({
        environmentId: ENVIRONMENT_ID,
        environmentPlatform: "MacIntel",
        rawCwd: "C:\\Work\\Repo",
        projects: [],
        threads: [],
        sidebarThreadSortOrder: "updated_at",
        defaultThreadEnvMode: "local",
        createProject: vi.fn(),
        handleNewThread: vi.fn(),
        navigateToThread: vi.fn(),
      }),
    ).rejects.toThrow("Windows-style paths are only supported on Windows.");
  });
});
