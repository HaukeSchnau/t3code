/**
 * Presentation helpers shared by the fixture's transcript, Work panel and
 * standalone sidebar. Pure functions over the reduced state; every clock is
 * the frozen `state.now`.
 */
import type { FixtureProvider, FixtureState, FixtureThreadStatus } from "./model";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Elapsed between two instants: `4m`, `1h 12m`, `3d`. */
export function formatElapsed(fromIso: string, toIso: string): string {
  const delta = Math.max(0, Date.parse(toIso) - Date.parse(fromIso));
  if (delta < MINUTE) return `${Math.floor(delta / 1000)}s`;
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) {
    const hours = Math.floor(delta / HOUR);
    const minutes = Math.floor((delta % HOUR) / MINUTE);
    return minutes === 0 ? `${hours}h` : `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  return `${Math.floor(delta / DAY)}d`;
}

/** Sidebar-style relative label: `now`, `4m`, `2h`, `3d`. */
export function formatRelative(iso: string, nowIso: string): string {
  const delta = Math.max(0, Date.parse(nowIso) - Date.parse(iso));
  if (delta < MINUTE) return "now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  return `${Math.floor(delta / DAY)}d`;
}

export function formatClock(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

export interface StatusVisual {
  readonly dotClass: string;
  readonly label: string;
  readonly textClass: string;
}

/**
 * One steady in-flight presentation, matching the Agents panel rule: live
 * states read as Working, only settled and blocked states differentiate.
 */
export function statusVisual(status: FixtureThreadStatus): StatusVisual {
  switch (status) {
    case "queued":
      return {
        dotClass: "bg-muted-foreground/50",
        label: "Starting",
        textClass: "text-muted-foreground",
      };
    case "running":
      return { dotClass: "bg-info", label: "Working", textClass: "text-sky-600 dark:text-sky-400" };
    case "blocked-approval":
      return {
        dotClass: "bg-warning",
        label: "Approval",
        textClass: "text-amber-700 dark:text-amber-300",
      };
    case "blocked-input":
      return {
        dotClass: "bg-warning",
        label: "Input",
        textClass: "text-indigo-600 dark:text-indigo-300",
      };
    case "completed":
      return { dotClass: "bg-success", label: "Done", textClass: "text-muted-foreground" };
    case "failed":
      return {
        dotClass: "bg-destructive",
        label: "Failed",
        textClass: "text-red-700 dark:text-red-300",
      };
    case "stopped":
      return {
        dotClass: "bg-muted-foreground/60",
        label: "Stopped",
        textClass: "text-muted-foreground",
      };
  }
}

export const PROVIDER_LABELS: Record<FixtureProvider, string> = {
  codex: "Codex",
  claude: "Claude",
  glm: "GLM",
};

/** The label the delegating parent chose, or the thread title when it is a root. */
export function displayLabel(state: FixtureState, threadId: string): string {
  return state.delegations[threadId]?.label ?? state.threads[threadId]?.title ?? threadId;
}

export function projectTitle(state: FixtureState, projectId: string): string {
  return state.projects.find((project) => project.id === projectId)?.title ?? projectId;
}

/** Sidebar subtitle for a coordinator: `3 open efforts · 1 needs you`. */
export function coordinatorSummary(input: {
  readonly openEfforts: number;
  readonly attention: number;
  readonly waiting: number;
}): string | null {
  const parts: string[] = [];
  if (input.openEfforts > 0) {
    parts.push(`${input.openEfforts} open effort${input.openEfforts === 1 ? "" : "s"}`);
  }
  if (input.attention > 0) {
    parts.push(`${input.attention} need${input.attention === 1 ? "s" : ""} you`);
  } else if (input.waiting > 0) {
    parts.push(`waiting on ${input.waiting}`);
  }
  return parts.length === 0 ? null : parts.join(" · ");
}
