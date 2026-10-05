/**
 * Fork: server-managed workspaces in the composer (patches/workspaces.md).
 * Servers that advertise them create jj workspaces, guarded directory copies
 * or isolated runtimes, so a new workspace needs neither Git nor a base branch.
 */
import { useAtomValue } from "@effect/atom-react";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import {
  type EnvironmentId,
  type ManagedWorkspacesCapability,
  type ServerConfig,
  WorkspaceProfile,
} from "@t3tools/contracts";

import { getLocalStorageItem, useLocalStorage } from "../hooks/useLocalStorage";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "../state/server";

const WORKSPACE_PROFILE_STORAGE_KEY = "t3code:workspace-profile";

function capabilityFor(
  config: ServerConfig | null,
  projectRoot: string | null | undefined,
): ManagedWorkspacesCapability | null {
  // Threads without a project already get a folder of their own.
  if (
    config === null ||
    projectRoot == null ||
    isScratchProject({ workspaceRoot: projectRoot }, config.scratchWorkspaceRoot)
  ) {
    return null;
  }
  return config.environment.capabilities.managedWorkspaces ?? null;
}

export function useManagedWorkspaces(
  environmentId: EnvironmentId | null,
  projectRoot: string | null | undefined,
): ManagedWorkspacesCapability | null {
  return capabilityFor(useAtomValue(serverEnvironment.configValueAtom(environmentId)), projectRoot);
}

/** Read at send time, so a reconnect to another server version is honoured. */
function readManagedWorkspaces(
  environmentId: EnvironmentId,
  projectRoot: string,
): ManagedWorkspacesCapability | null {
  return capabilityFor(
    appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId)),
    projectRoot,
  );
}

/** Familiar unless the user chose Minimal under Advanced; only isolated workspaces use it. */
export function useWorkspaceProfile() {
  return useLocalStorage<WorkspaceProfile, WorkspaceProfile>(
    WORKSPACE_PROFILE_STORAGE_KEY,
    "familiar",
    WorkspaceProfile,
  );
}

function readWorkspaceProfile(): WorkspaceProfile {
  try {
    return getLocalStorageItem(WORKSPACE_PROFILE_STORAGE_KEY, WorkspaceProfile) ?? "familiar";
  } catch {
    return "familiar";
  }
}

/** The bootstrap field for a new managed workspace, or undefined when the server has none. */
export function managedWorkspaceBootstrap(input: {
  readonly environmentId: EnvironmentId;
  readonly projectRoot: string;
  readonly baseBranch: string | null;
  readonly startFromOrigin: boolean;
}) {
  const capability = readManagedWorkspaces(input.environmentId, input.projectRoot);
  if (capability === null) return undefined;
  return {
    ...(input.baseBranch === null ? {} : { baseRef: input.baseBranch }),
    ...(input.startFromOrigin ? { startFromOrigin: true } : {}),
    ...(capability.isolated ? { profile: readWorkspaceProfile() } : {}),
  };
}
