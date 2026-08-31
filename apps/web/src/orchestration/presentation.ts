/**
 * The words and the colour each orchestration state gets, in one table.
 *
 * Kept out of the components so the roster, the graph node, the batch card and
 * the comparison table cannot drift into three different names for the same
 * condition — which is the specific way a dashboard starts lying.
 *
 * Tones are semantic, not literal colours: `attention` means a person has to
 * act, `bad` means the run is over and it went badly. Only `attention` and
 * `bad` are allowed to be loud.
 */
import type { VariantProps } from "class-variance-authority";

import type { badgeVariants } from "../components/ui/badge";
import type { BarrierStatus, BatchPhase, WorkerState } from "./model";

export type OrchestrationTone = "neutral" | "active" | "attention" | "good" | "bad";

export interface StatePresentation {
  readonly label: string;
  readonly tone: OrchestrationTone;
}

export const WORKER_STATE_PRESENTATION: Record<WorkerState, StatePresentation> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "active" },
  blocked: { label: "Blocked", tone: "attention" },
  completed: { label: "Completed", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  timedOut: { label: "Timed out", tone: "bad" },
};

export const BATCH_PHASE_PRESENTATION: Record<BatchPhase, StatePresentation> = {
  launching: { label: "Launching", tone: "neutral" },
  working: { label: "Working", tone: "active" },
  attention: { label: "Needs you", tone: "attention" },
  settled: { label: "Settled", tone: "good" },
};

export const BARRIER_STATUS_PRESENTATION: Record<BarrierStatus, StatePresentation> = {
  open: { label: "Barrier open", tone: "active" },
  satisfied: { label: "Barrier satisfied", tone: "good" },
  timedOut: { label: "Barrier timed out", tone: "bad" },
  cancelled: { label: "Barrier cancelled", tone: "neutral" },
};

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

const TONE_BADGE_VARIANT: Record<OrchestrationTone, BadgeVariant> = {
  neutral: "secondary",
  active: "info",
  attention: "warning",
  good: "success",
  bad: "error",
};

export function toneBadgeVariant(tone: OrchestrationTone): BadgeVariant {
  return TONE_BADGE_VARIANT[tone];
}

/**
 * Background class for the small state dot. Deliberately static: a pulsing dot
 * on a page that can show forty workers is a repaint per frame per worker.
 */
const TONE_DOT_CLASS: Record<OrchestrationTone, string> = {
  neutral: "bg-muted-foreground/60",
  active: "bg-info",
  attention: "bg-warning",
  good: "bg-success",
  bad: "bg-destructive",
};

export function toneDotClass(tone: OrchestrationTone): string {
  return TONE_DOT_CLASS[tone];
}

const TONE_TEXT_CLASS: Record<OrchestrationTone, string> = {
  neutral: "text-muted-foreground",
  active: "text-info-foreground",
  attention: "text-warning-foreground",
  good: "text-success-foreground",
  bad: "text-destructive-foreground",
};

export function toneTextClass(tone: OrchestrationTone): string {
  return TONE_TEXT_CLASS[tone];
}

/**
 * Relative age, for cards where the exact clock time is noise. Rounds down, so
 * a batch is never described as older than it is.
 */
export function formatRelativeAge(iso: string, now: number): string | null {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}
