/**
 * Fork: server-managed workspaces in the new-task flow (patches/workspaces.md).
 * jj and directory projects get jj workspaces or copies without Git or a base branch, and an
 * isolated runtime only when chosen. Plain Git projects keep upstream's worktree flow.
 */
import { workspaceLabel } from "@t3tools/client-runtime/state/workspaces";
import type { ManagedWorkspacesCapability, WorkspaceProfile } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";

/** Setup for isolated workspaces; Familiar until changed on this device. */
export const workspaceProfileAtom = Atom.make<WorkspaceProfile>("familiar").pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:workspace-profile"),
);

/** Isolation is a choice per launch: the picker sets it and a submitted task clears it. */
export const workspaceIsolatedAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:workspace-isolated"),
);

/** What a queued task records for a new managed workspace, spread into its creation. */
export function managedWorkspaceCreation(capability: ManagedWorkspacesCapability | null): {
  readonly managedWorkspace?: { readonly isolated?: boolean; readonly profile?: WorkspaceProfile };
} {
  if (capability === null) return {};
  return {
    managedWorkspace:
      capability.isolated && appAtomRegistry.get(workspaceIsolatedAtom)
        ? { isolated: true, profile: appAtomRegistry.get(workspaceProfileAtom) }
        : {},
  };
}

export function managedWorkspaceDisplayLabel(input: {
  readonly workspaceMode: "local" | "worktree";
  readonly worktreePath: string | null;
  readonly isolated?: boolean;
}): string {
  if (input.workspaceMode === "worktree") {
    return input.isolated ? "New isolated workspace" : "New workspace";
  }
  return input.worktreePath === null ? "Project checkout" : workspaceLabel(input.worktreePath);
}
