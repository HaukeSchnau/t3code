/**
 * `/fixtures/orchestration` — dev-only route for the orchestration fixture:
 * efforts, durable waits, retries, nested and cooperative work, a debate,
 * contextual Compare with artifact lenses, and a two-up preview.
 *
 * Absent from nav on purpose. No sockets, no timers; every clock is the
 * frozen step clock. The virtual environment sync starts here so enabling
 * the fixture publishes its threads while the app is open.
 */
import { createFileRoute } from "@tanstack/react-router";

import {
  OrchestrationFixturePage,
  startFixtureEnvironmentSync,
} from "../components/orchestration-fixture";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";

function FixturesUnavailable() {
  return (
    <SidebarInset className="items-center justify-center bg-background text-foreground">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Not available</EmptyTitle>
          <EmptyDescription>
            Fixtures are development-only surfaces and are not part of a shipped build.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}

if (import.meta.env.DEV) {
  startFixtureEnvironmentSync();
}

export const Route = createFileRoute("/fixtures/orchestration")({
  component: import.meta.env.DEV ? OrchestrationFixturePage : FixturesUnavailable,
});
