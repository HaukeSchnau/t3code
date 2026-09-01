/**
 * Settled-only child of `DelegationRow`: one bounded line per worker, plus the
 * checkboxes that pick Compare's two columns.
 *
 * The strip never grows. It carries verdict, tests, diff size and a way in —
 * the reasoning is the coordinator's assistant message below the row, not here.
 */
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { cn } from "~/lib/utils";
import type { DelegationVerdict, DelegationWorkerView } from "./fixtureData";
import { WorkerGlyph } from "./WorkerGlyph";

const VERDICT_PRESENTATION: Record<
  DelegationVerdict,
  { readonly mark: string; readonly label: string; readonly className: string }
> = {
  accepted: { mark: "✓", label: "Accepted", className: "text-success" },
  partial: { mark: "◐", label: "Partial", className: "text-warning-foreground" },
  rejected: { mark: "✗", label: "Rejected", className: "text-destructive-foreground" },
};

/** Compare needs exactly two columns; the footer button is the only gate. */
export const COMPARE_COLUMN_COUNT = 2;

export function DelegationResultStrip({
  workers,
  selectedKeys,
  onToggleSelection,
  onCompare,
  onOpenWorker,
}: {
  readonly workers: readonly DelegationWorkerView[];
  readonly selectedKeys: readonly string[];
  readonly onToggleSelection: (key: string) => void;
  readonly onCompare: () => void;
  readonly onOpenWorker: (key: string) => void;
}) {
  const canCompare = selectedKeys.length === COMPARE_COLUMN_COUNT;

  return (
    <div className="border-border/60 border-t">
      <ul className="flex flex-col py-0.5">
        {workers.map((worker) => {
          const result = worker.result;
          if (!result) return null;
          const verdict = VERDICT_PRESENTATION[result.verdict];
          const selected = selectedKeys.includes(worker.key);
          return (
            <li key={worker.key} className="flex items-center gap-2.5 px-2.5 py-1 text-[13px]">
              <Checkbox
                aria-label={`Compare ${worker.label}`}
                checked={selected}
                onCheckedChange={() => onToggleSelection(worker.key)}
              />
              <WorkerGlyph glyph={worker.glyph} className="size-3.5" />
              <span className="w-14 shrink-0 truncate font-medium">{worker.label}</span>
              <span
                className={cn(
                  "flex w-24 shrink-0 items-center gap-1.5 truncate",
                  verdict.className,
                )}
              >
                <span aria-hidden>{verdict.mark}</span>
                {verdict.label}
              </span>
              <span className="hidden w-28 shrink-0 font-mono text-[.7rem] text-muted-foreground tabular-nums sm:block">
                {result.tests}
              </span>
              <span className="hidden shrink-0 font-mono text-[.7rem] tabular-nums sm:block">
                <span className="text-success">+{result.additions}</span>{" "}
                <span className="text-destructive-foreground">−{result.deletions}</span>
              </span>
              <button
                type="button"
                onClick={() => onOpenWorker(worker.key)}
                className="ms-auto shrink-0 rounded-sm px-1 font-mono text-[.7rem] text-info-foreground transition hover:bg-accent/50"
              >
                Open ▸
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-end gap-3 border-border/60 border-t px-2.5 py-1.5">
        {canCompare ? null : (
          <span className="font-mono text-[.7rem] text-muted-foreground">Pick two to compare</span>
        )}
        <Button disabled={!canCompare} onClick={onCompare} size="compact" variant="outline">
          Compare selected ({selectedKeys.length})
        </Button>
      </div>
    </div>
  );
}
