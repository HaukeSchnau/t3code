/**
 * The batch grouping in the Agents panel — the third kind of group beside
 * workflows and phases.
 *
 * One lane per worker: provider glyph, one-line activity, elapsed, and — only
 * while a worker is blocked — its question verbatim with a single way out.
 * Reading the question is free; answering it happens in the child thread, so
 * the lane carries no composer.
 */
import { cn } from "~/lib/utils";
import {
  delegationCountsLabel,
  type DelegationFixtureState,
  type DelegationWorkerView,
} from "./fixtureData";
import { WorkerGlyph } from "./WorkerGlyph";

function isBlocked(worker: DelegationWorkerView): boolean {
  return worker.member.outcome === "blocked-input" || worker.member.outcome === "blocked-approval";
}

function DelegationLane({
  worker,
  focused,
  onOpenThread,
}: {
  readonly worker: DelegationWorkerView;
  readonly focused: boolean;
  readonly onOpenThread: () => void;
}) {
  const blocked = isBlocked(worker);

  return (
    <li
      className={cn("rounded-md px-1.5 py-1.5 transition-colors", focused ? "bg-accent/60" : null)}
    >
      <div className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2">
        <WorkerGlyph
          glyph={worker.glyph}
          needsReview={blocked}
          indicatorBackground={focused ? "var(--accent)" : "var(--card)"}
        />
        <span className="min-w-0 truncate font-medium text-sm">{worker.label}</span>
        <span className="font-mono text-[.7rem] text-muted-foreground/80 tabular-nums">
          {worker.elapsed}
        </span>
        <span
          className={cn(
            "col-start-2 col-end-4 block truncate text-xs",
            blocked ? "text-warning-foreground" : "text-muted-foreground",
          )}
        >
          {worker.activity}
        </span>
        <span className="col-start-2 col-end-4 truncate font-mono text-[.7rem] text-muted-foreground/70">
          {worker.member.thread.modelSelection.model}
        </span>
      </div>
      {worker.reviewRequest ? (
        <div className="mt-1.5 ms-6 rounded-md border border-warning/32 bg-warning-surface px-2 py-1.5">
          <p className="text-xs text-foreground">{worker.reviewRequest}</p>
          <button
            type="button"
            onClick={onOpenThread}
            className="mt-1.5 rounded-sm font-mono text-[.7rem] text-warning-foreground underline-offset-2 transition hover:underline"
          >
            Open thread →
          </button>
        </div>
      ) : null}
    </li>
  );
}

export function AgentsPanelBatchGroup({
  state,
  focusedWorkerKey,
  onOpenWorker,
}: {
  readonly state: DelegationFixtureState;
  readonly focusedWorkerKey: string | null;
  readonly onOpenWorker: (key: string) => void;
}) {
  return (
    <section className="flex flex-col gap-1">
      <header className="flex items-baseline gap-2 px-1.5 pt-1">
        <span className="min-w-0 truncate font-medium text-[.65rem] uppercase tracking-wider text-muted-foreground">
          Delegated · {state.task}
        </span>
        <span className="ms-auto shrink-0 font-mono text-[.7rem] text-muted-foreground/80">
          {state.elapsed}
        </span>
      </header>
      <ul className="flex flex-col gap-0.5">
        {state.workers.map((worker) => (
          <DelegationLane
            key={worker.key}
            worker={worker}
            focused={focusedWorkerKey === worker.key}
            onOpenThread={() => onOpenWorker(worker.key)}
          />
        ))}
      </ul>
      <footer className="px-1.5 pt-1 font-mono text-[.7rem] text-muted-foreground">
        {delegationCountsLabel(state.counts)}
      </footer>
    </section>
  );
}
