import {
  buildProjectCreateCommand,
  resolveAddProjectPath,
} from "@t3tools/client-runtime/operations";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { findProjectByPath } from "@t3tools/client-runtime/state/projects";
import type {
  CommandId,
  EnvironmentId,
  ProjectId,
  ScopedProjectRef,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";

import type { DraftThreadEnvMode } from "../composerDraftStore";
import { getLatestThreadForProject, type ThreadSortInput } from "./threadSort";

interface WorkspaceProjectLike {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}

interface WorkspaceThreadLike extends ThreadSortInput {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly archivedAt: string | null;
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
  readonly newCommandId: () => CommandId;
  readonly newProjectId: () => ProjectId;
  readonly dispatchCreateProject: (
    command: ReturnType<typeof buildProjectCreateCommand>,
  ) => Promise<unknown>;
  readonly handleNewThread: (
    projectRef: ScopedProjectRef,
    options?: { envMode?: DraftThreadEnvMode },
  ) => Promise<void>;
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

  const path = resolveAddProjectPath({
    rawPath: input.rawCwd,
    platform: input.environmentPlatform,
    ...(input.currentProjectCwd === undefined
      ? {}
      : { currentProjectCwd: input.currentProjectCwd }),
  });
  if (!path.ok) {
    throw new Error(path.error);
  }

  const existingProject = findProjectByPath(
    input.projects.filter((project) => project.environmentId === input.environmentId),
    path.path,
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

  const projectId = input.newProjectId();
  await input.dispatchCreateProject(
    buildProjectCreateCommand({
      commandId: input.newCommandId(),
      projectId,
      workspaceRoot: path.path,
      createdAt: new Date().toISOString(),
    }),
  );
  await input.handleNewThread(scopeProjectRef(input.environmentId, projectId), {
    envMode: input.defaultThreadEnvMode,
  });
  return "created-project";
}
