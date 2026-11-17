import type { ScheduledTask } from "@t3tools/contracts";

type WorkspaceStrategy = ScheduledTask["workspaceStrategy"];

/** The workspace fields a scheduled task form edits. A managed workspace edits as a new worktree. */
export interface ScheduledTaskWorkspaceChoice {
  readonly mode: "root" | "worktree" | "existing_worktree";
  readonly baseRef: string;
  readonly startFromOrigin: boolean;
  readonly checkoutPath: string;
}

export function scheduledTaskWorkspaceChoice(
  strategy: WorkspaceStrategy,
): ScheduledTaskWorkspaceChoice {
  const managed = strategy.type === "worktree" || strategy.type === "workspace";
  return {
    mode: strategy.type === "workspace" ? "worktree" : strategy.type,
    baseRef: (managed ? strategy.baseRef : undefined) ?? "main",
    startFromOrigin: managed ? (strategy.startFromOrigin ?? false) : true,
    checkoutPath: strategy.type === "existing_worktree" ? strategy.worktreePath : "",
  };
}

/** Keeps the saved strategy, including fields the form does not show, unless the form changed it. */
export function scheduledTaskWorkspaceStrategy(
  choice: ScheduledTaskWorkspaceChoice,
  saved: WorkspaceStrategy | null,
): WorkspaceStrategy {
  const normalized = { ...choice, baseRef: choice.baseRef.trim() || "main" };
  if (saved !== null && sameChoice(normalized, scheduledTaskWorkspaceChoice(saved))) return saved;
  if (normalized.mode === "root") return { type: "root" };
  if (normalized.mode === "existing_worktree") {
    return { type: "existing_worktree", worktreePath: normalized.checkoutPath.trim() };
  }
  return {
    ...(saved?.type === "workspace" ? saved : { type: "worktree" }),
    baseRef: normalized.baseRef,
    startFromOrigin: normalized.startFromOrigin,
  };
}

function sameChoice(a: ScheduledTaskWorkspaceChoice, b: ScheduledTaskWorkspaceChoice): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode === "existing_worktree") return a.checkoutPath.trim() === b.checkoutPath;
  if (a.mode === "worktree")
    return a.baseRef === b.baseRef && a.startFromOrigin === b.startFromOrigin;
  return true;
}
