import { ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { FIXTURE_STEPS } from "./scenario";
import { useOrchestrationFixtureStore } from "./store";

/**
 * Scenario scrubber. One slim bar: step counter, caption, previous, next,
 * reset. Stepping back hides user actions taken at later steps; Reset drops
 * them. Nothing here ticks.
 */
export function StepStrip({ className }: { readonly className?: string }) {
  const cursor = useOrchestrationFixtureStore((store) => store.cursor);
  const stepBack = useOrchestrationFixtureStore((store) => store.stepBack);
  const stepForward = useOrchestrationFixtureStore((store) => store.stepForward);
  const reset = useOrchestrationFixtureStore((store) => store.reset);
  const userEventCount = useOrchestrationFixtureStore((store) => store.userEvents.length);
  const step = FIXTURE_STEPS[cursor];
  const last = FIXTURE_STEPS.length - 1;

  return (
    <div
      data-testid="orchestration-fixture-step-strip"
      className={cn(
        "flex h-8 shrink-0 items-center gap-2 border-t border-border/60 bg-card/60 px-2 text-xs text-muted-foreground",
        className,
      )}
    >
      <span className="shrink-0 rounded-sm border border-border/60 px-1 font-mono text-[.65rem] uppercase tracking-wider">
        Fixture
      </span>
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label="Previous step"
        disabled={cursor === 0}
        onClick={stepBack}
      >
        <ChevronLeft />
      </Button>
      <span className="shrink-0 font-mono tabular-nums">
        {cursor + 1}/{FIXTURE_STEPS.length}
      </span>
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label="Next step"
        disabled={cursor === last}
        onClick={stepForward}
      >
        <ChevronRight />
      </Button>
      <span className="min-w-0 flex-1 truncate text-foreground/80">{step?.caption}</span>
      {userEventCount > 0 ? (
        <span className="hidden shrink-0 font-mono text-[.65rem] sm:inline">
          {userEventCount} user action{userEventCount === 1 ? "" : "s"}
        </span>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Reset scenario"
              onClick={reset}
            />
          }
        >
          <RotateCcw />
        </TooltipTrigger>
        <TooltipPopup>Reset to the scripted scenario</TooltipPopup>
      </Tooltip>
    </div>
  );
}
