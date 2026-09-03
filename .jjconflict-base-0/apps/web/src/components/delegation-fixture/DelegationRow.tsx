/**
 * The transcript event row for one delegation batch — sibling of
 * `AgentSpawnCtaRow`, and the only place a batch appears in the timeline.
 *
 * The row does not grow prose. It carries the task, the worker glyphs, one
 * count phrase and elapsed; the count phrase and elapsed are the only mutable
 * pixels. On settle it gains a bounded result strip and nothing else — the
 * coordinator's assessment is an ordinary assistant message *after* this row,
 * which is the tool-result-then-message ordering the timeline already teaches.
 */
import { Bot } from "lucide-react";

import { cn } from "~/lib/utils";
import {
  delegationCountsLabel,
  type DelegationCounts,
  type DelegationPhase,
  type DelegationWorkerView,
} from "./fixtureData";
import { DelegationResultStrip } from "./DelegationResultStrip";
import { WorkerGlyph } from "./WorkerGlyph";

function needsReview(worker: DelegationWorkerView): boolean {
  return worker.member.outcome === "blocked-input" || worker.member.outcome === "blocked-approval";
}

export function DelegationRow({
  task,
  workers,
  phase,
  counts,
  elapsed,
  onOpenBatch,
  selectedKeys,
  onToggleSelection,
  onCompare,
  onOpenWorker,
}: {
  readonly task: string;
  readonly workers: readonly DelegationWorkerView[];
  readonly phase: DelegationPhase;
  readonly counts: DelegationCounts;
  readonly elapsed: string;
  /** Click target for the whole row: the batch group in the Agents panel. */
  readonly onOpenBatch: () => void;
  readonly selectedKeys: readonly string[];
  readonly onToggleSelection: (key: string) => void;
  readonly onCompare: () => void;
  readonly onOpenWorker: (key: string) => void;
}) {
  const settled = phase === "settled";

  return (
    <div className="overflow-hidden rounded-md border border-border/60 bg-card/50">
      <button
        type="button"
        onClick={onOpenBatch}
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] transition hover:bg-accent/50",
        )}
      >
        <Bot aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium">Delegated “{task}”</span>
        <span className="flex shrink-0 items-center gap-1.5">
          {workers.map((worker) => (
            <WorkerGlyph
              key={worker.key}
              glyph={worker.glyph}
              needsReview={needsReview(worker)}
              className="size-3.5"
            />
          ))}
        </span>
        <span className="ms-auto flex shrink-0 items-center gap-2 font-mono text-[.7rem] text-muted-foreground">
          <span className="hidden sm:inline">{delegationCountsLabel(counts)}</span>
          <span className="tabular-nums">{elapsed}</span>
          <span className="text-info-foreground">{settled ? "View ▸" : "Open Agents ▸"}</span>
        </span>
      </button>
      {settled ? (
        <DelegationResultStrip
          workers={workers}
          selectedKeys={selectedKeys}
          onToggleSelection={onToggleSelection}
          onCompare={onCompare}
          onOpenWorker={onOpenWorker}
        />
      ) : null}
    </div>
  );
}
