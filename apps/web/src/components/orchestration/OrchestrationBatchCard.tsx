/**
 * One batch, as a card: what it was asked to do, what the barrier is doing
 * about it, and every member's honest disposition.
 *
 * The roster is never filtered or collapsed by state. A batch where one arm
 * failed has to read as "one arm failed", not as a shorter list, so a failed or
 * cancelled member keeps its row and its reason.
 */
import { Columns3Icon, CpuIcon, ServerIcon, TimerIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { nonEmptyTallyEntries } from "../../orchestration/dashboardState";
import { formatDuration, type BatchView, type WorkerView } from "../../orchestration/model";
import {
  BARRIER_STATUS_PRESENTATION,
  BATCH_PHASE_PRESENTATION,
  WORKER_STATE_PRESENTATION,
  formatRelativeAge,
  toneTextClass,
} from "../../orchestration/presentation";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { StateDot, ToneBadge } from "./OrchestrationStateBadge";

/** A muted meta chip: an icon and a value, wrapped rather than truncated. */
function Meta({
  icon,
  children,
  className,
}: {
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
      <span aria-hidden className="[&_svg]:size-3 [&_svg]:opacity-70">
        {icon}
      </span>
      <span className="truncate">{children}</span>
    </span>
  );
}

export function OrchestrationWorkerRow({ worker }: { readonly worker: WorkerView }) {
  const presentation = WORKER_STATE_PRESENTATION[worker.state];
  const duration = formatDuration(worker.durationMs);
  return (
    <li className="flex min-w-0 flex-col gap-1.5 px-4 py-3">
      <div className="flex min-w-0 items-start gap-2">
        <StateDot className="mt-1.5" presentation={presentation} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 truncate font-medium text-sm text-foreground">
              {worker.title}
            </span>
            {worker.role ? (
              <Badge size="sm" variant="outline">
                {worker.role}
              </Badge>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
            {worker.modelLabel ? <Meta icon={<CpuIcon />}>{worker.modelLabel}</Meta> : null}
            <Meta icon={<ServerIcon />}>{worker.hostLabel}</Meta>
            {duration ? <Meta icon={<TimerIcon />}>{duration}</Meta> : null}
            <span className="inline-flex min-w-0 items-center gap-1">
              <span className="truncate font-mono text-[11px]">{worker.workspaceLabel}</span>
              {/* Parallel arms writing one checkout is a correctness hazard, so
                  the shared case is loud and the isolated case is silent. */}
              {worker.isolated ? null : (
                <Badge size="sm" variant="warning">
                  <TriangleAlertIcon />
                  shared checkout
                </Badge>
              )}
            </span>
          </div>
        </div>
        <ToneBadge className="shrink-0" presentation={presentation} />
      </div>
      {worker.reason ? (
        <p className={cn("ps-4 text-xs", toneTextClass(presentation.tone))}>{worker.reason}</p>
      ) : null}
      {worker.summary ? (
        <p className="line-clamp-2 ps-4 text-muted-foreground text-xs">{worker.summary}</p>
      ) : null}
    </li>
  );
}

export function OrchestrationBatchCard({
  batch,
  now,
  onCompare,
}: {
  readonly batch: BatchView;
  readonly now: number;
  readonly onCompare: (batchId: string) => void;
}) {
  const phase = BATCH_PHASE_PRESENTATION[batch.phase];
  const barrier = BARRIER_STATUS_PRESENTATION[batch.barrier.status];
  const age = formatRelativeAge(batch.createdAt, now);

  return (
    <Card className="min-w-0 overflow-hidden">
      <div className="flex min-w-0 flex-col gap-3 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 className="min-w-0 text-pretty font-semibold text-base text-foreground">
              {batch.title}
            </h2>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
              <span className="font-mono">{batch.shortId}</span>
              {age ? <span>· {age}</span> : null}
            </div>
          </div>
          <ToneBadge className="shrink-0" presentation={phase} size="default" />
        </div>

        {batch.intent ? (
          <p className="line-clamp-2 text-muted-foreground text-sm">{batch.intent}</p>
        ) : null}

        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <ToneBadge presentation={barrier} />
          <span className="min-w-0 text-muted-foreground text-xs">{batch.barrierLabel}</span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {nonEmptyTallyEntries(batch.tally).map((entry) => {
            const state = WORKER_STATE_PRESENTATION[entry.state];
            return (
              <span
                key={entry.state}
                className="inline-flex items-center gap-1.5 rounded-sm bg-muted/60 px-1.5 py-0.5 text-xs"
              >
                <StateDot presentation={state} />
                <span className="text-muted-foreground">
                  {entry.count} {state.label.toLowerCase()}
                </span>
              </span>
            );
          })}
        </div>
      </div>

      <ul className="m-0 flex list-none flex-col divide-y border-t p-0">
        {batch.workers.map((worker) => (
          <OrchestrationWorkerRow key={worker.key} worker={worker} />
        ))}
      </ul>

      {/* The way out of the card. Offered on every batch with more than one arm,
          disabled (not hidden) while the arms are still moving, so the action
          does not appear from nowhere the moment a batch settles. */}
      {batch.workers.length > 1 ? (
        <div className="flex items-center justify-end border-t px-4 py-2.5">
          <Button
            disabled={batch.tally.outstanding > 0}
            onClick={() => onCompare(batch.batchId)}
            size="compact"
            variant="outline"
          >
            <Columns3Icon />
            {batch.tally.outstanding > 0 ? "Compare when settled" : "Compare arms"}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
