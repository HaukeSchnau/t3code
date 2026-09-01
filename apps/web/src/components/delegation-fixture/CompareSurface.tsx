/**
 * Compare: exactly two workers, three aligned sections each.
 *
 * Desktop renders two columns that scroll independently under sticky section
 * headers, so `answer / diff / tests` line up whichever column you are reading.
 * Mobile renders the same component with worker tabs — one column, and nothing
 * ever scrolls horizontally.
 *
 * There is deliberately no third column: three columns in a right panel is
 * three unreadable columns.
 */
import { useState } from "react";

import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { cn } from "~/lib/utils";
import type { DelegationVerdict, DelegationWorkerView } from "./fixtureData";
import { WorkerGlyph } from "./WorkerGlyph";

const VERDICT_LABELS: Record<DelegationVerdict, { label: string; className: string }> = {
  accepted: { label: "✓ Accepted", className: "text-success" },
  partial: { label: "◐ Partial", className: "text-warning-foreground" },
  rejected: { label: "✗ Rejected", className: "text-destructive-foreground" },
};

function SectionHeading({ children }: { readonly children: string }) {
  return (
    <h3 className="sticky top-0 z-10 border-border/40 border-b bg-background/95 px-3 py-1.5 font-medium text-[.65rem] uppercase tracking-wider text-muted-foreground backdrop-blur-sm">
      {children}
    </h3>
  );
}

const DIFF_TONE_CLASS = {
  add: "text-success",
  remove: "text-destructive-foreground",
  context: "text-muted-foreground",
} as const;

/** Diff lines are pre-formatted text, so the sign at column zero is the signal. */
function parseDiff(diff: string) {
  return diff.split("\n").map(
    (text, index) =>
      ({
        id: `${index}:${text}`,
        text,
        tone: text.startsWith("+") ? "add" : text.startsWith("-") ? "remove" : "context",
      }) as const,
  );
}

function DiffBlock({ diff }: { readonly diff: string }) {
  return (
    <pre className="whitespace-pre-wrap break-words px-3 py-2 font-mono text-[.7rem] leading-relaxed">
      {parseDiff(diff).map((line) => (
        <span className={cn("block", DIFF_TONE_CLASS[line.tone])} key={line.id}>
          {line.text}
        </span>
      ))}
    </pre>
  );
}

function CompareColumn({
  worker,
  className,
}: {
  readonly worker: DelegationWorkerView;
  readonly className?: string;
}) {
  const result = worker.result;
  const verdict = result ? VERDICT_LABELS[result.verdict] : null;

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col", className)}>
      <header className="flex shrink-0 items-center gap-2 border-border/60 border-b px-3 py-2">
        <WorkerGlyph glyph={worker.glyph} className="size-4" />
        <span className="min-w-0 truncate font-medium text-sm">{worker.label}</span>
        {verdict ? (
          <span className={cn("ms-auto shrink-0 font-mono text-[.7rem]", verdict.className)}>
            {verdict.label}
          </span>
        ) : null}
      </header>
      <ScrollArea className="min-h-0 flex-1">
        {result ? (
          <div className="flex flex-col pb-6">
            <SectionHeading>Answer</SectionHeading>
            <p className="px-3 py-2 text-sm leading-relaxed">{result.answer}</p>
            <SectionHeading>Diff</SectionHeading>
            <DiffBlock diff={result.diff} />
            <SectionHeading>Tests</SectionHeading>
            <pre className="whitespace-pre-wrap break-words px-3 py-2 font-mono text-[.7rem] leading-relaxed text-muted-foreground">
              {result.testOutput}
            </pre>
          </div>
        ) : (
          <p className="px-3 py-6 text-center text-muted-foreground text-xs">
            This worker has not reported a result yet.
          </p>
        )}
      </ScrollArea>
    </div>
  );
}

export function CompareSurface({
  workers,
  variant,
}: {
  /** At most two, already in batch order. */
  readonly workers: readonly DelegationWorkerView[];
  readonly variant: "columns" | "tabs";
}) {
  const first = workers[0];
  const [activeKey, setActiveKey] = useState<string | null>(null);

  if (!first) {
    return (
      <p className="p-6 text-center text-muted-foreground text-xs">
        Pick two results in the timeline to compare them.
      </p>
    );
  }

  if (variant === "columns") {
    return (
      // A single auto row would size to the taller column and defeat the
      // independent scrolls, so the row is pinned to the available height.
      <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-[minmax(0,1fr)] divide-x divide-border/60">
        {workers.map((worker) => (
          <CompareColumn key={worker.key} worker={worker} />
        ))}
      </div>
    );
  }

  const active = workers.find((worker) => worker.key === activeKey) ?? first;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="sticky top-0 z-20 shrink-0 border-border/60 border-b bg-background/95 px-2 py-1.5 backdrop-blur-sm">
        <ToggleGroup
          aria-label="Compared worker"
          className="w-full"
          onValueChange={(next) => {
            const value = next[0];
            if (typeof value === "string") setActiveKey(value);
          }}
          value={[active.key]}
          variant="segmented"
        >
          {workers.map((worker) => (
            <Toggle key={worker.key} className="flex-1" value={worker.key}>
              {worker.label}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
      <CompareColumn className="flex-1" worker={active} />
    </div>
  );
}
