import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import type {
  EnvironmentId,
  ProjectId,
  ScopedProjectRef,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";

import type { DraftThreadEnvMode } from "../composerDraftStore";
import { getLatestThreadForProject } from "./threadSort";
import {
  findProjectByPath,
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
  isUnsupportedWindowsProjectPath,
  resolveProjectPathForDispatch,
} from "./projectPaths";

interface WorkspaceProjectLike {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

interface WorkspaceThreadLike {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt?: string | undefined;
}

interface NewThreadHandler {
  (projectRef: ScopedProjectRef, options?: { envMode?: DraftThreadEnvMode }): Promise<void>;
}

export interface OpenWorkspaceInAppInput {
  readonly environmentId: EnvironmentId | null;
  readonly environmentPlatform: string;
  readonly rawCwd: string;
  readonly currentProjectCwd?: string | null;
  readonly projects: readonly WorkspaceProjectLike[];
  readonly threads: readonly WorkspaceThreadLike[];
  readonly sidebarThreadSortOrder: SidebarThreadSortOrder;
  readonly defaultThreadEnvMode: DraftThreadEnvMode;
  readonly createProject: (input: { cwd: string; title: string }) => Promise<ProjectId>;
  readonly handleNewThread: NewThreadHandler;
  readonly navigateToThread: (threadRef: ScopedThreadRef) => Promise<void>;
}

export type OpenWorkspaceInAppResult =
  | "opened-existing-thread"
  | "opened-existing-project"
  | "created-project";

export async function openWorkspaceInApp(
  input: OpenWorkspaceInAppInput,
): Promise<OpenWorkspaceInAppResult> {
  if (!input.environmentId) {
    throw new Error("Local environment is not ready yet.");
  }

  const trimmedPath = input.rawCwd.trim();
  if (isUnsupportedWindowsProjectPath(trimmedPath, input.environmentPlatform)) {
    throw new Error("Windows-style paths are only supported on Windows.");
  }

  if (isExplicitRelativeProjectPath(trimmedPath) && !input.currentProjectCwd) {
    throw new Error("Relative paths require an active project.");
  }

  const cwd = resolveProjectPathForDispatch(trimmedPath, input.currentProjectCwd);
  if (cwd.length === 0) {
    throw new Error("Workspace path is required.");
  }

  const existingProject = findProjectByPath(
    input.projects.filter((project) => project.environmentId === input.environmentId),
    cwd,
  );
  if (existingProject) {
    const latestThread = getLatestThreadForProject(
      input.threads.filter((thread) => thread.environmentId === input.environmentId),
      existingProject.id,
      input.sidebarThreadSortOrder,
    );
    if (latestThread) {
      await input.navigateToThread(scopeThreadRef(latestThread.environmentId, latestThread.id));
      return "opened-existing-thread";
    }

    await input.handleNewThread(
      scopeProjectRef(existingProject.environmentId, existingProject.id),
      {
        envMode: input.defaultThreadEnvMode,
      },
    );
    return "opened-existing-project";
  }

  const projectId = await input.createProject({
    cwd,
    title: inferProjectTitleFromPath(cwd),
  });
  await input.handleNewThread(scopeProjectRef(input.environmentId, projectId), {
    envMode: input.defaultThreadEnvMode,
  });
  return "created-project";
}
