import type { PlacementPreview, PlacementPreviewResult } from "@t3tools/contracts";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

/** Auto on a new task: the server's placement picks its machine on send (patches/fleet-placement.md). */
export interface NewTaskPlacement {
  /** The draft's machine offers Auto. */
  readonly available: boolean;
  /** The task goes where placement picks. */
  readonly automatic: boolean;
  /** Something in the draft keeps the task on the draft's machine. */
  readonly staysHere: boolean;
  readonly preview: PlacementPreview | null;
}

/**
 * What only the client knows ties a task to the draft's machine, as the web composer counts it,
 * so the send skips placement: a triage prompt links this machine's playbook, a pull request is
 * checked out here, and chosen repositories name this machine's paths.
 */
export function newTaskLaunchesHere(input: {
  readonly isTriage: boolean;
  readonly workspaceMode: "local" | "worktree";
  readonly pullRequestReference: string | undefined;
  readonly choosesRepositories: boolean;
}): boolean {
  return (
    input.isTriage ||
    (input.workspaceMode === "worktree" &&
      (input.pullRequestReference !== undefined || input.choosesRepositories))
  );
}

export function resolveNewTaskPlacement(input: {
  readonly preview: {
    readonly data: PlacementPreviewResult | null;
    readonly isPending: boolean;
    readonly error: string | null;
  };
  readonly environmentSelection: "auto" | "manual" | undefined;
  /** A local task in another worktree of the repository runs in that machine's folder. */
  readonly worktreePath: string | null;
  readonly launchesHere: boolean;
  /** What the server keeps on the draft's machine: attachments, context, a local base commit. */
  readonly server: {
    readonly hasAttachments: boolean;
    readonly hasContext: boolean;
    readonly branchesFromLocalCommit: boolean;
  };
}): NewTaskPlacement {
  const { data, isPending, error } = input.preview;
  // An unanswered preview (loading, or offline) keeps Auto; only "no machine takes it" drops it.
  const available = data === null ? isPending || error !== null : data.preview !== null;
  const { hasAttachments, hasContext, branchesFromLocalCommit } = input.server;
  return {
    available,
    automatic: available && input.environmentSelection !== "manual" && input.worktreePath === null,
    staysHere: input.launchesHere || hasAttachments || hasContext || branchesFromLocalCommit,
    preview: data?.preview ?? null,
  };
}

export function newTaskPlacementLabel(
  placement: NewTaskPlacement,
  sourceLabel: string,
  resolve: MessageResolver = m,
): string {
  if (placement.staysHere) {
    return resolve(msg("Auto → {machine} (stays here)", { machine: sourceLabel }));
  }
  const preview = placement.preview;
  if (preview === null) return resolve(msg("Auto", { $context: "automatic machine choice" }));
  return preview.wait
    ? resolve(msg("Auto → {machine} (waits for room)", { machine: preview.label }))
    : resolve(msg("Auto → {machine}", { machine: preview.label }));
}
