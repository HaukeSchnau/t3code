/**
 * The dashboard's own state rules, kept out of the components.
 *
 * Which batch a comparison opens on, how many arms may sit side by side, and
 * what the header says about the fleet are all decisions with a right answer —
 * so they live here where a test can hold them still, rather than inside a
 * `useState` where they drift.
 */
import { MAX_COMPARISON_COLUMNS } from "./comparison";
import type { BatchTally, BatchView, WorkerState } from "./model";

export const ORCHESTRATION_VIEW_MODES = ["list", "graph", "comparison"] as const;
export type OrchestrationViewMode = (typeof ORCHESTRATION_VIEW_MODES)[number];

export const ORCHESTRATION_VIEW_MODE_LABELS: Record<OrchestrationViewMode, string> = {
  list: "Batches",
  graph: "Graph",
  comparison: "Compare",
};

export function isOrchestrationViewMode(value: string): value is OrchestrationViewMode {
  return (ORCHESTRATION_VIEW_MODES as readonly string[]).includes(value);
}

export interface FleetSummary {
  readonly batches: number;
  readonly workers: number;
  readonly running: number;
  readonly blocked: number;
  /**
   * Every member reported and the coordinator is still asleep. It is the one
   * fleet-level condition nobody thinks to look for, so the header names it.
   */
  readonly awaitingCoordinator: number;
}

export function summarizeFleet(batches: readonly BatchView[]): FleetSummary {
  let workers = 0;
  let running = 0;
  let blocked = 0;
  let awaitingCoordinator = 0;
  for (const batch of batches) {
    workers += batch.tally.total;
    running += batch.tally.running;
    blocked += batch.tally.blocked;
    if (batch.barrier.status === "open" && batch.tally.outstanding === 0) {
      awaitingCoordinator += 1;
    }
  }
  return { batches: batches.length, workers, running, blocked, awaitingCoordinator };
}

/** Explicit plurals: "batch" does not take a bare "s". */
const counted = (count: number, singular: string, plural: string) =>
  `${count} ${count === 1 ? singular : plural}`;

/**
 * One line for the top bar. Only conditions that are actually happening get a
 * clause: a fleet with nothing blocked should not read "0 blocked", because a
 * zero that is always on screen stops being read at all.
 */
export function fleetSummaryLabel(summary: FleetSummary): string {
  if (summary.batches === 0) {
    return "No batches";
  }
  const parts = [
    `${counted(summary.workers, "worker", "workers")} in ${counted(summary.batches, "batch", "batches")}`,
  ];
  if (summary.running > 0) {
    parts.push(`${summary.running} running`);
  }
  if (summary.blocked > 0) {
    parts.push(`${summary.blocked} blocked`);
  }
  if (summary.awaitingCoordinator > 0) {
    parts.push(`${summary.awaitingCoordinator} waking`);
  }
  return parts.join(" · ");
}

/**
 * The batch a comparison should show. An explicit pick always wins; otherwise
 * the first batch worth comparing does, and failing that the newest batch, so
 * switching to compare never lands on an empty screen.
 */
export function resolveComparisonBatch(
  batches: readonly BatchView[],
  requestedBatchId: string | null,
): BatchView | null {
  if (requestedBatchId) {
    const requested = batches.find((batch) => batch.batchId === requestedBatchId);
    if (requested) {
      return requested;
    }
  }
  return batches.find((batch) => batch.comparable) ?? batches[0] ?? null;
}

export function canAddComparisonColumn(selectedKeys: readonly string[]): boolean {
  return selectedKeys.length < MAX_COMPARISON_COLUMNS;
}

/**
 * Adds or removes an arm. The last column never leaves — a comparison of
 * nothing is a broken view, not a valid selection — and the cap is enforced
 * here so a stale button can't push a fifth column past `deriveComparison`.
 */
export function toggleComparisonSelection(
  selectedKeys: readonly string[],
  key: string,
): readonly string[] {
  if (selectedKeys.includes(key)) {
    return selectedKeys.length <= 1 ? selectedKeys : selectedKeys.filter((entry) => entry !== key);
  }
  return canAddComparisonColumn(selectedKeys) ? [...selectedKeys, key] : selectedKeys;
}

/**
 * The tally chips a card shows, in the order a person reads them: what is
 * happening now, then what is waiting, then how it ended. States nobody hit are
 * dropped — a row of zeroes is noise that trains people to stop reading the row.
 */
const TALLY_ORDER = [
  "running",
  "blocked",
  "queued",
  "completed",
  "failed",
  "timedOut",
  "cancelled",
] as const satisfies readonly WorkerState[];

export function nonEmptyTallyEntries(
  tally: BatchTally,
): readonly { readonly state: WorkerState; readonly count: number }[] {
  return TALLY_ORDER.map((state) => ({ state, count: tally[state] })).filter(
    (entry) => entry.count > 0,
  );
}
