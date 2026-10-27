/**
 * Fork: server-managed workspaces in the new-task flow (patches/workspaces.md).
 * For jj and directory projects, servers that advertise them create jj workspaces, guarded
 * directory copies or isolated runtimes, so a new workspace needs neither Git nor a base branch.
 * Plain Git projects keep upstream's worktree flow.
 */
import { workspaceLabel } from "@t3tools/client-runtime/state/workspaces";
import type { ManagedWorkspacesCapability, WorkspaceProfile } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";

/** Advanced choice for isolated workspaces; Familiar until changed on this device. */
export const workspaceProfileAtom = Atom.make<WorkspaceProfile>("familiar").pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:workspace-profile"),
);

/** What a queued task records for a new managed workspace, spread into its creation. */
export function managedWorkspaceCreation(capability: ManagedWorkspacesCapability | null): {
  readonly managedWorkspace?: { readonly profile?: WorkspaceProfile };
} {
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
