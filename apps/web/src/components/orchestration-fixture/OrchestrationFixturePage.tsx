/**
 * `/fixtures/orchestration` — the standalone page.
 *
 * The fixture publishes into the ordinary global sidebar. This route is the
 * control room: choose a frozen step, then enter any sample thread through
 * the same URL and app shell as a real thread.
 */
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Switch } from "../ui/switch";
import { cn } from "~/lib/utils";
import { FIXTURE_ENVIRONMENT_ID } from "./fixtureEnvironment";
import { formatClock } from "./presentation";
import { effortsOf } from "./reducer";
import { COORDINATOR_ID, FIXTURE_STEPS } from "./scenario";
import { StepStrip } from "./StepStrip";
import { useFixtureState, useOrchestrationFixtureStore } from "./store";

function Overview({ onOpenThread }: { readonly onOpenThread: (threadId: string) => void }) {
  const state = useFixtureState();
  const enabled = useOrchestrationFixtureStore((store) => store.enabled);
  const setEnabled = useOrchestrationFixtureStore((store) => store.setEnabled);
  const cursor = useOrchestrationFixtureStore((store) => store.cursor);
  const setCursor = useOrchestrationFixtureStore((store) => store.setCursor);
  const efforts = effortsOf(state, COORDINATOR_ID);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-8">
      <div>
        <h1 className="text-lg font-semibold">Orchestration fixture</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          One coordinator, several efforts, durable waits, a replacement, nested delegation,
          cooperative work with two previews, and a debate. Scrub the steps, then correct things by
          hand.
        </p>
      </div>

      <label className="flex items-center gap-3 rounded-lg border border-border/60 bg-card/40 px-3 py-2.5">
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label="Show fixture threads in the global sidebar"
        />
        <span className="flex min-w-0 flex-col">
          <span className="text-sm font-medium">Virtual environment in the global sidebar</span>
          <span className="text-xs text-muted-foreground">
            Publishes the fixture threads through the environment atoms while integration lands.
            Persisted in this browser only.
          </span>
        </span>
      </label>

      <section>
        <h2 className="mb-2 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
          Entry points
        </h2>
        <div className="flex flex-wrap gap-2">
          <Button size="compact" onClick={() => onOpenThread(COORDINATOR_ID)}>
            Platform coordinator
          </Button>
          {efforts.map((effort) => {
            const first = effort.members[0];
            return first === undefined ? null : (
              <Button
                key={effort.id}
                size="compact"
                variant="outline"
                onClick={() => onOpenThread(first)}
              >
                {effort.title}
                {effort.closedAt !== null ? " · closed" : ""}
              </Button>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
          Steps
        </h2>
        <ol className="flex flex-col gap-px rounded-lg border border-border/60 bg-card/30 p-1">
          {FIXTURE_STEPS.map((step, index) => (
            <li key={step.at}>
              <button
                type="button"
                onClick={() => setCursor(index)}
                aria-current={index === cursor ? "step" : undefined}
                className={cn(
                  "flex w-full items-baseline gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/50",
                  index === cursor && "bg-accent text-foreground",
                  index > cursor && "text-muted-foreground",
                )}
              >
                <span className="w-5 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1">{step.caption}</span>
                <span className="shrink-0 font-mono text-[.65rem] tabular-nums text-muted-foreground/70">
                  {formatClock(step.at)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

export function OrchestrationFixturePage() {
  const navigate = useNavigate();
  const setEnabled = useOrchestrationFixtureStore((store) => store.setEnabled);

  useEffect(() => setEnabled(true), [setEnabled]);

  const openThread = (threadId: string) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: FIXTURE_ENVIRONMENT_ID, threadId },
    });
  };

  return (
    <DiffWorkerPoolProvider>
      <SidebarInset
        className="h-svh min-h-0 overflow-hidden bg-background text-foreground md:h-dvh"
        data-testid="orchestration-fixture-page"
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 bg-card/40 px-3 text-xs text-muted-foreground">
            <span>Orchestration fixture</span>
            <span className="ml-auto font-mono text-[.65rem]">dev only</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Overview onOpenThread={openThread} />
          </div>
          <StepStrip />
        </div>
      </SidebarInset>
    </DiffWorkerPoolProvider>
  );
}
