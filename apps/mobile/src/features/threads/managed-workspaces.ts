/**
 * Fork: server-managed workspaces in the new-task flow (patches/workspaces.md).
 * Servers that advertise them create jj workspaces, guarded directory copies
 * or isolated runtimes, so a new workspace needs neither Git nor a base branch.
 */
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { workspaceLabel } from "@t3tools/client-runtime/state/workspaces";
import type {
  ManagedWorkspacesCapability,
  ServerConfig,
  WorkspaceProfile,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";

/** Advanced choice for isolated workspaces; Familiar until changed on this device. */
export const workspaceProfileAtom = Atom.make<WorkspaceProfile>("familiar").pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:workspace-profile"),
);

/** Threads without a project already get a folder of their own. */
export function managedWorkspacesFor(
  config: ServerConfig | null | undefined,
  projectRoot: string | null | undefined,
): ManagedWorkspacesCapability | null {
  if (
    config == null ||
    projectRoot == null ||
    isScratchProject({ workspaceRoot: projectRoot }, config.scratchWorkspaceRoot)
  ) {
    return null;
  }
  return config.environment.capabilities.managedWorkspaces ?? null;
}

/** What a queued task records for a new managed workspace, spread into its creation. */
export function managedWorkspaceCreation(
  config: ServerConfig | null | undefined,
  projectRoot: string | null | undefined,
): { readonly managedWorkspace?: { readonly profile?: WorkspaceProfile } } {
  const capability = managedWorkspacesFor(config, projectRoot);
  if (capability === null) return {};
  return {
    managedWorkspace: capability.isolated
      ? { profile: appAtomRegistry.get(workspaceProfileAtom) }
      : {},
  };
}

export function managedWorkspaceDisplayLabel(input: {
  readonly workspaceMode: "local" | "worktree";
  readonly worktreePath: string | null;
}): string {
  if (input.workspaceMode === "worktree") return "New workspace";
  return input.worktreePath === null ? "Project checkout" : workspaceLabel(input.worktreePath);
}
