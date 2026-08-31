/**
 * Two to four arms of one batch, side by side.
 *
 * Rows the arms agree on are legible but quiet; rows they disagree on are
 * emphasised, because agreement is context and disagreement is the finding.
 * An arm that never produced a result still gets its column and says why.
 */
import { CheckIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import {
  deriveComparison,
  MAX_COMPARISON_COLUMNS,
  type ComparisonView,
} from "../../orchestration/comparison";
import { canAddComparisonColumn } from "../../orchestration/dashboardState";
import type { BatchView } from "../../orchestration/model";
import {
  BARRIER_STATUS_PRESENTATION,
  WORKER_STATE_PRESENTATION,
} from "../../orchestration/presentation";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { StateDot, ToneBadge } from "./OrchestrationStateBadge";

/** The arm picker. Every member is offered, including the ones that failed. */
function ArmPicker({
  batch,
  selectedKeys,
  onToggle,
}: {
  readonly batch: BatchView;
  readonly selectedKeys: readonly string[];
  readonly onToggle: (key: string) => void;
}) {
  const full = !canAddComparisonColumn(selectedKeys);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {batch.workers.map((worker) => {
          const selected = selectedKeys.includes(worker.key);
          const presentation = WORKER_STATE_PRESENTATION[worker.state];
          return (
            <Button
              key={worker.key}
              aria-pressed={selected}
              // A full picker disables what it cannot add rather than hiding
              // it, so the cap is visible instead of mysterious.
              disabled={!selected && full}
              onClick={() => onToggle(worker.key)}
              size="compact"
              variant={selected ? "secondary" : "outline"}
            >
              {selected ? <CheckIcon /> : <StateDot presentation={presentation} />}
              {worker.role ?? worker.title}
            </Button>
          );
        })}
      </div>
      <span className="text-muted-foreground text-xs">
        {full
          ? `Showing the maximum of ${MAX_COMPARISON_COLUMNS} arms side by side.`
          : `Pick up to ${MAX_COMPARISON_COLUMNS} arms.`}
      </span>
    </div>
  );
}

function ComparisonTable({ comparison }: { readonly comparison: ComparisonView }) {
  const columnWidth = `${Math.round(70 / comparison.columns.length)}%`;
  return (
    // Horizontal scroll rather than a stacked mobile layout: the whole point of
    // this view is reading one row across every arm, and stacking destroys it.
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full min-w-[36rem] caption-bottom border-collapse text-sm">
        <thead>
          <tr className="border-b">
            <th className="sticky start-0 bg-background px-3 py-2 text-start font-medium text-muted-foreground text-xs">
              Field
            </th>
            {comparison.columns.map((column) => {
              const presentation = WORKER_STATE_PRESENTATION[column.worker.state];
              return (
                <th
                  key={column.worker.key}
                  className="px-3 py-2 text-start align-top font-medium"
                  style={{ width: columnWidth }}
                >
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="min-w-0 truncate text-foreground text-sm">
                      {column.worker.role ?? column.worker.title}
                    </span>
                    <ToneBadge className="self-start" presentation={presentation} />
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {comparison.rows.map((row) => (
            <tr key={row.label} className="border-b last:border-b-0">
              <th
                className="sticky start-0 bg-background px-3 py-2 text-start align-top font-normal text-muted-foreground text-xs"
                scope="row"
              >
                <span className="inline-flex items-center gap-1.5">
                  {row.label}
                  {row.differs ? (
                    <Badge size="sm" variant="info">
                      differs
                    </Badge>
                  ) : null}
                </span>
              </th>
              {row.values.map((value, index) => (
                <td
                  // Column identity is the arm, and an arm can repeat a value.
                  key={comparison.columns[index]?.worker.key ?? index}
                  className={cn(
                    "px-3 py-2 align-top text-sm tabular-nums",
                    row.differs ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  {value ?? <span className="text-muted-foreground/60">—</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The result each arm reported, or the reason it has none. */
function ArmResults({ comparison }: { readonly comparison: ComparisonView }) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {comparison.columns.map((column) => (
        <Card key={column.worker.key} className="min-w-0 gap-2 p-3">
          <span className="min-w-0 truncate font-medium text-foreground text-sm">
            {column.worker.role ?? column.worker.title}
          </span>
          {column.hasResult ? (
            <p className="text-muted-foreground text-xs">
              {column.worker.summary ?? "Completed without a reported summary."}
            </p>
          ) : (
            <p className="text-warning-foreground text-xs">{column.unavailableReason}</p>
          )}
        </Card>
      ))}
    </div>
  );
}

export function OrchestrationComparisonView({
  batch,
  selectedKeys,
  onToggle,
}: {
  readonly batch: BatchView;
  readonly selectedKeys: readonly string[];
  readonly onToggle: (key: string) => void;
}) {
  const comparison = deriveComparison(batch, selectedKeys);
  const barrier = BARRIER_STATUS_PRESENTATION[batch.barrier.status];

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex min-w-0 flex-col gap-2">
        <h2 className="text-pretty font-semibold text-foreground text-lg">{batch.title}</h2>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <ToneBadge presentation={barrier} />
          <span className="text-muted-foreground text-xs">{batch.barrierLabel}</span>
        </div>
        {batch.intent ? <p className="text-muted-foreground text-sm">{batch.intent}</p> : null}
      </div>

      <ArmPicker batch={batch} onToggle={onToggle} selectedKeys={selectedKeys} />

      {comparison.columns.length === 0 ? (
        <p className="text-muted-foreground text-sm">Pick an arm to compare.</p>
      ) : (
        <>
          <Card className="min-w-0 overflow-hidden py-1">
            <ComparisonTable comparison={comparison} />
          </Card>
          <ArmResults comparison={comparison} />
        </>
      )}
    </div>
  );
}
