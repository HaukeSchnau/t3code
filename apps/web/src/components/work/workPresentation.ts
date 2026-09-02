/**
 * Presentation helpers for the Work surface. Status is the only place colour
 * appears; everything else stays monochrome.
 */
import type { WorkerState } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

export interface WorkerStateVisual {
  readonly label: string;
  readonly dotClass: string;
  readonly textClass: string;
}

export function workerStateVisual(state: WorkerState): WorkerStateVisual {
  switch (state) {
    case "working":
      return { label: "Working", dotClass: "bg-info", textClass: "text-sky-600 dark:text-sky-400" };
    case "blocked":
      return {
        label: "Needs you",
        dotClass: "bg-warning",
        textClass: "text-amber-700 dark:text-amber-300",
      };
    case "completed":
      return { label: "Done", dotClass: "bg-success", textClass: "text-muted-foreground" };
    case "failed":
      return {
        label: "Failed",
        dotClass: "bg-destructive",
        textClass: "text-red-700 dark:text-red-300",
      };
    case "stopped":
      return {
        label: "Stopped",
        dotClass: "bg-muted-foreground/60",
        textClass: "text-muted-foreground",
      };
    case "idle":
      return {
        label: "Idle",
        dotClass: "bg-muted-foreground/40",
        textClass: "text-muted-foreground",
      };
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Elapsed between two instants, rendered once per commit; nothing ticks. */
export function formatElapsed(fromIso: string, toIso: string): string {
  const delta = Math.max(0, Date.parse(toIso) - Date.parse(fromIso));
  if (Number.isNaN(delta)) return "";
  if (delta < MINUTE) return `${Math.floor(delta / 1000)}s`;
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) {
    const hours = Math.floor(delta / HOUR);
    const minutes = Math.floor((delta % HOUR) / MINUTE);
    return minutes === 0 ? `${hours}h` : `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  return `${Math.floor(delta / DAY)}d`;
}

/** The worker's current step while live, otherwise nothing; outcomes come from state. */
export function workerActivityLine(
  shell: EnvironmentThreadShell,
  state: WorkerState,
): string | null {
  if (state === "working" && shell.planProgress?.step) return shell.planProgress.step;
  if (state === "failed" && shell.session?.lastError) return shell.session.lastError;
  return null;
}

export function workerElapsed(shell: EnvironmentThreadShell, nowIso: string): string | null {
  const start = shell.latestTurn?.startedAt ?? shell.latestTurn?.requestedAt ?? null;
  if (start === null) return null;
  return formatElapsed(start, shell.latestTurn?.completedAt ?? nowIso);
}
