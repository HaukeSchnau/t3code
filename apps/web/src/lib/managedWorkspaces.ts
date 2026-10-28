/**
 * Server-managed workspaces in the composer (patches/workspaces.md).
 * jj and directory projects get jj workspaces or copies without Git or a base branch, and an
 * isolated runtime only when chosen. Plain Git projects keep upstream's worktree flow.
 */
import { useAtomValue } from "@effect/atom-react";
import { useSyncExternalStore } from "react";
import { managedWorkspacesForProject } from "@t3tools/client-runtime/state/workspaces";
import {
  type EnvironmentId,
  type ManagedWorkspacesCapability,
  type VcsDriverKind,
  WorkspaceProfile,
} from "@t3tools/contracts";

import { getLocalStorageItem, useLocalStorage } from "../hooks/useLocalStorage";
import { serverEnvironment } from "../state/server";

const WORKSPACE_PROFILE_STORAGE_KEY = "t3code:workspace-profile";

export function useManagedWorkspaces(
  environmentId: EnvironmentId | null,
  projectRoot: string | null | undefined,
  vcsKind: VcsDriverKind | undefined,
  isRepo: boolean | undefined,
): ManagedWorkspacesCapability | null {
  return managedWorkspacesForProject({
    config: useAtomValue(serverEnvironment.configValueAtom(environmentId)),
    projectRoot,
    vcsKind,
    isRepo,
  });
}

// In memory, not stored: isolation stays a choice per launch, cleared by the send that uses it.
let isolatedNext = false;
const isolationListeners = new Set<() => void>();

export function setIsolatedWorkspaceChoice(isolated: boolean) {
  if (isolatedNext === isolated) return;
  isolatedNext = isolated;
  for (const listener of isolationListeners) listener();
}

export function useIsolatedWorkspaceChoice(): boolean {
  return useSyncExternalStore(
    (listener) => {
      isolationListeners.add(listener);
      return () => isolationListeners.delete(listener);
    },
    () => isolatedNext,
  );
}

/** Familiar unless the user chose Minimal; only isolated workspaces use it. */
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

/** The bootstrap field for a new managed workspace, or undefined for upstream's worktree flow. */
export function managedWorkspaceBootstrap(input: {
  readonly capability: ManagedWorkspacesCapability | null;
  readonly baseBranch: string | null;
  readonly startFromOrigin: boolean;
}) {
  const { capability } = input;
  if (capability === null) return undefined;
  return {
    ...(input.baseBranch === null ? {} : { baseRef: input.baseBranch }),
    ...(input.startFromOrigin ? { startFromOrigin: true } : {}),
    ...(capability.isolated && isolatedNext
      ? { isolated: true, profile: readWorkspaceProfile() }
      : {}),
  };
}
