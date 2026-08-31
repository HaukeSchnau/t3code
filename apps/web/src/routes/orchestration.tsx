/**
 * `/orchestration` — the batch dashboard.
 *
 * The dashboard's aggregate snapshot endpoint is not wired yet, so this route
 * feeds it the development fixture and says so on the page. It is deliberately
 * the only place that knows the data is fake: the dashboard itself renders the
 * same snapshot shape the live query will provide.
 *
 * TODO: replace `buildSampleOrchestrationSnapshot` with the served aggregate
 * snapshot and drop the sample-data banner once that query is wired.
 */
import { createFileRoute } from "@tanstack/react-router";
import { FlaskConicalIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { OrchestrationDashboard } from "../components/orchestration/OrchestrationDashboard";
import { Card } from "../components/ui/card";
import { buildSampleOrchestrationSnapshot } from "../orchestration/sampleData";

/**
 * Durations on a live batch go stale silently, so the page keeps a clock — but
 * a slow one. Half a minute is finer than any label it feeds ("4m", "1h 02m")
 * and costs two renders a minute, where a per-second tick would repaint the
 * whole roster sixty times for a number that did not change.
 */
const CLOCK_INTERVAL_MS = 30_000;

function useSlowClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, CLOCK_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return now;
}

function SampleDataNotice() {
  return (
    <Card className="flex-row items-start gap-3 border-warning/32 bg-warning/8 p-3">
      <FlaskConicalIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium text-sm text-warning-foreground">Sample data</span>
        <span className="text-muted-foreground text-xs">
          This preview uses representative batches pushed through the real adapter, including
          blocked, nested, cross-host, and mixed-result work.
        </span>
      </div>
    </Card>
  );
}

function OrchestrationRoute() {
  const now = useSlowClock();
  // The fixture is built once, from mount time. Rebuilding it on every tick
  // would move every timestamp with the clock and freeze all the durations.
  const snapshot = useMemo(() => buildSampleOrchestrationSnapshot(Date.now()), []);
  return <OrchestrationDashboard notice={<SampleDataNotice />} now={now} snapshot={snapshot} />;
}

export const Route = createFileRoute("/orchestration")({
  component: OrchestrationRoute,
});
