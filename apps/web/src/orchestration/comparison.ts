/**
 * Side-by-side comparison of a settled batch's arms.
 *
 * The point of a comparison view is the *differences*, so the rows carry a
 * `differs` flag and the view emphasises those. Workers that did not complete
 * still get a column — hiding a failed arm turns "2 of 3 approaches worked"
 * into a silent "2 approaches", which is the kind of quiet lie this product
 * does not tell.
 */
import { formatSubagentTokenCount } from "@t3tools/client-runtime/state/subagentRuntime";

import { formatDuration, type BatchView, type WorkerView } from "./model";

/** How many arms fit side by side before the view stops being readable. */
export const MAX_COMPARISON_COLUMNS = 4;

export interface ComparisonColumn {
  readonly worker: WorkerView;
  /** Only a completed worker has a result worth comparing. */
  readonly hasResult: boolean;
  readonly unavailableReason: string | null;
}

export interface ComparisonRow {
  readonly label: string;
  readonly values: readonly (string | null)[];
  /** True when the arms disagree — the only rows worth reading closely. */
  readonly differs: boolean;
}

export interface ComparisonView {
  readonly columns: readonly ComparisonColumn[];
  readonly rows: readonly ComparisonRow[];
}

/**
 * A row every arm is silent about says nothing. The server does not report
 * usage or diff stats for every provider, and a table of em-dashes reads as a
 * broken view rather than as missing telemetry.
 */
function hasAnyValue(candidate: ComparisonRow): boolean {
  return candidate.values.some((value) => value !== null);
}

function unavailableReasonFor(worker: WorkerView): string | null {
  switch (worker.state) {
    case "completed":
      return null;
    case "failed":
      return worker.reason ?? "Failed before producing a result";
    case "cancelled":
      return "Cancelled";
    case "timedOut":
      return "Timed out before reporting";
    case "blocked":
      return worker.reason ?? "Blocked and never finished";
    case "queued":
      return "Never started";
    case "running":
      return "Still running";
  }
}

function row(label: string, values: readonly (string | null)[]): ComparisonRow {
  const present = values.filter((value): value is string => value !== null);
  return {
    label,
    values,
    differs: new Set(present).size > 1,
  };
}

/**
 * The arms a comparison opens with: completed first, then anything else, so a
 * batch where one arm crashed still opens on the two results worth reading.
 */
export function defaultComparisonSelection(batch: BatchView): readonly string[] {
  const completed = batch.workers.filter((worker) => worker.state === "completed");
  const rest = batch.workers.filter((worker) => worker.state !== "completed");
  return [...completed, ...rest].slice(0, MAX_COMPARISON_COLUMNS).map((worker) => worker.key);
}

export function deriveComparison(
  batch: BatchView,
  selectedKeys: readonly string[],
): ComparisonView {
  const selected = new Set(selectedKeys);
  // Batch order, not click order: the arms keep the positions the roster and
  // the graph put them in.
  const columns: ComparisonColumn[] = batch.workers
    .filter((worker) => selected.has(worker.key))
    .slice(0, MAX_COMPARISON_COLUMNS)
    .map((worker) => ({
      worker,
      hasResult: worker.state === "completed",
      unavailableReason: unavailableReasonFor(worker),
    }));

  const workers = columns.map((column) => column.worker);
  const rows: ComparisonRow[] = [
    row(
      "Outcome",
      workers.map((worker) => worker.state),
    ),
    row(
      "Model",
      workers.map((worker) => worker.modelLabel),
    ),
    row(
      "Host",
      workers.map((worker) => worker.hostLabel),
    ),
    row(
      // A shared checkout is a correctness hazard between parallel arms, so it
      // travels with the workspace rather than hiding in a badge somewhere else.
      "Workspace",
      workers.map((worker) =>
        worker.isolated ? worker.workspaceLabel : `${worker.workspaceLabel} (shared)`,
      ),
    ),
    row(
      "Duration",
      workers.map((worker) => formatDuration(worker.durationMs)),
    ),
    row(
      "Tokens",
      workers.map((worker) =>
        worker.usage ? `${formatSubagentTokenCount(worker.usage.totalTokens)}` : null,
      ),
    ),
    row(
      "Turns",
      workers.map((worker) => (worker.usage ? `${worker.usage.turns}` : null)),
    ),
    row(
      "Files changed",
      workers.map((worker) => (worker.diffStat ? `${worker.diffStat.files}` : null)),
    ),
    row(
      "Lines",
      workers.map((worker) =>
        worker.diffStat ? `+${worker.diffStat.insertions} −${worker.diffStat.deletions}` : null,
      ),
    ),
  ];

  return { columns, rows: rows.filter(hasAnyValue) };
}
