import { ChevronRight, GitFork } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { DELEGATION_FIXTURE_STATES, type DelegationWorkerView } from "./fixtureData";
import { useDelegationFixtureStore } from "./fixtureState";
import { WorkerGlyph } from "./WorkerGlyph";

function workerStatus(worker: DelegationWorkerView): {
  readonly label: string;
  readonly className: string;
} {
  switch (worker.member.outcome) {
    case "blocked-approval":
    case "blocked-input":
      return { label: "Needs review", className: "text-amber-700 dark:text-amber-300" };
    case "running":
      return { label: "Working", className: "text-sky-600 dark:text-sky-400" };
    case "completed":
      return { label: "Ready", className: "text-sidebar-muted-foreground/70" };
    case "failed":
      return { label: "Failed", className: "text-destructive-foreground" };
    case "interrupted":
      return { label: "Stopped", className: "text-sidebar-muted-foreground/70" };
    case "unknown":
    case "queued":
      return { label: "Starting", className: "text-sidebar-muted-foreground/70" };
  }
}

/** Dev-fixture lineage rendered inside the real global sidebar. */
export function DelegationSidebarFixture() {
  const phase = useDelegationFixtureStore((state) => state.phase);
  const state = DELEGATION_FIXTURE_STATES[phase];
  const [settledExpanded, setSettledExpanded] = useState(false);
  const childrenVisible = phase !== "settled" || settledExpanded;
  const needsReview = state.counts.needsReview > 0;

  useEffect(() => {
    if (phase !== "settled") setSettledExpanded(false);
  }, [phase]);

  return (
    <li className="list-none" data-testid="delegation-fixture-lineage">
      <div className="rounded-md bg-sidebar-row-active text-sidebar-foreground">
        <div className="flex min-w-0 items-center gap-2 px-2.5 pt-2 text-[11px]">
          <GitFork aria-hidden className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
          <span className="truncate text-sidebar-muted-foreground">Parent · 3 workers</span>
          <span
            className={cn(
              "ms-auto shrink-0 font-medium",
              needsReview
                ? "text-amber-700 dark:text-amber-300"
                : phase === "settled"
                  ? "text-sidebar-muted-foreground"
                  : "text-sky-600 dark:text-sky-400",
            )}
          >
            {needsReview ? "Needs review" : phase === "settled" ? "Ready" : "Working"}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-2 px-2.5 pt-1 pb-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/90">
            Fix flaky checkpoint restore test
          </span>
          {phase === "settled" ? (
            <button
              type="button"
              aria-expanded={settledExpanded}
              aria-label="Show child threads"
              onClick={() => setSettledExpanded((expanded) => !expanded)}
              className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            >
              3 children
              <ChevronRight
                aria-hidden
                className={cn("size-3 transition-transform", settledExpanded && "rotate-90")}
              />
            </button>
          ) : null}
        </div>
      </div>

      {childrenVisible ? (
        <ul className="ms-3 mt-0.5 flex flex-col gap-px border-s border-sidebar-border/70 ps-2">
          {state.workers.map((worker) => {
            const status = workerStatus(worker);
            const blocked =
              worker.member.outcome === "blocked-input" ||
              worker.member.outcome === "blocked-approval";
            return (
              <li key={worker.key} className="list-none">
                <button
                  type="button"
                  className="flex h-9 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left hover:bg-sidebar-row-hover"
                >
                  <WorkerGlyph
                    glyph={worker.glyph}
                    needsReview={blocked}
                    className="size-3.5 shrink-0"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground/90">
                    {worker.label} · checkpoint fix
                  </span>
                  <span className={cn("shrink-0 text-[11px]", status.className)}>
                    {status.label}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}
