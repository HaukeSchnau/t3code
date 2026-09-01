/**
 * `/fixtures/delegation` — dev-only fixture for the delegation row, its settled
 * result strip, the Agents-panel batch group and Compare.
 *
 * Deliberately absent from nav: it exists so the three states can be reviewed
 * without a live batch. No sockets, no subscriptions, no timers — every elapsed
 * value on the page is a frozen string.
 */
import { createFileRoute } from "@tanstack/react-router";

import { DelegationFixtureView } from "../components/delegation-fixture/DelegationFixtureView";
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

export const Route = createFileRoute("/fixtures/delegation")({
  component: import.meta.env.DEV ? DelegationFixtureView : FixturesUnavailable,
});
