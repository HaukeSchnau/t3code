/**
 * The orchestration dashboard shell: one snapshot, three ways to read it.
 *
 * The component owns no derivation. Batches come from `deriveBatchViews`, the
 * header line from `summarizeFleet`, the comparison selection rules from
 * `dashboardState` — so what this file decides is layout and nothing else.
 *
 * `now` is a prop rather than a `Date.now()` call, which keeps every duration
 * on the page consistent with every other one and lets the route decide how
 * often the page is allowed to repaint.
 */
import { Columns3Icon, LayoutListIcon, NetworkIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import {
  fleetSummaryLabel,
  isOrchestrationViewMode,
  resolveComparisonBatch,
  summarizeFleet,
  toggleComparisonSelection,
  ORCHESTRATION_VIEW_MODES,
  ORCHESTRATION_VIEW_MODE_LABELS,
  type OrchestrationViewMode,
} from "../../orchestration/dashboardState";
import { defaultComparisonSelection } from "../../orchestration/comparison";
import { deriveBatchViews, type OrchestrationSnapshotWire } from "../../orchestration/model";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { OrchestrationBatchCard } from "./OrchestrationBatchCard";
import { OrchestrationComparisonView } from "./OrchestrationComparisonView";
import { OrchestrationGraphView } from "./OrchestrationGraphView";

const MODE_ICONS: Record<OrchestrationViewMode, ReactNode> = {
  list: <LayoutListIcon />,
  graph: <NetworkIcon />,
  comparison: <Columns3Icon />,
};

export function OrchestrationDashboard({
  snapshot,
  now,
  notice,
}: {
  readonly snapshot: OrchestrationSnapshotWire;
  readonly now: number;
  /** Rendered above the content. The sample-data banner lives here. */
  readonly notice?: ReactNode;
}) {
  const batches = useMemo(() => deriveBatchViews(snapshot.batches, now), [snapshot.batches, now]);
  const summary = useMemo(() => summarizeFleet(batches), [batches]);

  const [mode, setMode] = useState<OrchestrationViewMode>("list");
  const [comparisonBatchId, setComparisonBatchId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // Click order is not column order, so the selection is a set of keys and the
  // comparison re-derives from batch order every render.
  const [selectedArmKeys, setSelectedArmKeys] = useState<readonly string[] | null>(null);

  const comparisonBatch = resolveComparisonBatch(batches, comparisonBatchId);
  const armKeys =
    selectedArmKeys ?? (comparisonBatch ? defaultComparisonSelection(comparisonBatch) : []);

  const openComparison = (batchId: string) => {
    setComparisonBatchId(batchId);
    // A new batch starts from its own default arms, never from the last one's.
    setSelectedArmKeys(null);
    setMode("comparison");
  };

  // Both switches hand back a loose value: the segmented group an array, the
  // select a nullable string. The mode only ever changes through this guard.
  const selectMode = (next: string | null) => {
    if (next !== null && isOrchestrationViewMode(next)) {
      setMode(next);
    }
  };

  const topbarContent = (
    <div className="flex w-full min-w-0 items-center gap-3">
      <WorkspaceBreadcrumb ariaLabel="Orchestration breadcrumb" className="min-w-0">
        <WorkspaceBreadcrumbItem current>
          <h1>Orchestration</h1>
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator className="hidden md:flex" />
        <WorkspaceBreadcrumbItem className="hidden min-w-0 shrink md:flex">
          <span className="truncate">{fleetSummaryLabel(summary)}</span>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      <div className="ms-auto hidden min-w-0 items-center justify-end gap-2 md:flex">
        <ToggleGroup
          aria-label="Orchestration view"
          onValueChange={(next) => {
            const value = next[0];
            if (value) selectMode(value);
          }}
          value={[mode]}
          variant="segmented"
        >
          {ORCHESTRATION_VIEW_MODES.map((option) => (
            <Toggle key={option} value={option}>
              {ORCHESTRATION_VIEW_MODE_LABELS[option]}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
      <div className="ms-auto flex min-w-0 items-center justify-end md:hidden">
        <Select onValueChange={selectMode} value={mode}>
          <SelectTrigger
            aria-label="Orchestration view"
            className="w-auto min-w-0"
            size="compact"
            variant="ghost"
          >
            <SelectValue>{ORCHESTRATION_VIEW_MODE_LABELS[mode]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {ORCHESTRATION_VIEW_MODES.map((option) => (
              <SelectItem key={option} value={option}>
                <span className="inline-flex items-center gap-2">
                  {MODE_ICONS[option]}
                  {ORCHESTRATION_VIEW_MODE_LABELS[option]}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
    </div>
  );

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>{topbarContent}</WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="expanded">
            {notice}
            {/* The summary is in the top bar from md up; below that the bar has
                only room for the title and the mode switch. */}
            <p className="text-muted-foreground text-sm md:hidden">{fleetSummaryLabel(summary)}</p>

            {batches.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No batches yet</EmptyTitle>
                  <EmptyDescription>
                    A batch appears here when a coordinator launches durable workers and waits on
                    them.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : mode === "list" ? (
              <div className="grid min-w-0 gap-4 xl:grid-cols-2">
                {batches.map((batch) => (
                  <OrchestrationBatchCard
                    key={batch.batchId}
                    batch={batch}
                    now={now}
                    onCompare={openComparison}
                  />
                ))}
              </div>
            ) : mode === "graph" ? (
              <OrchestrationGraphView
                batches={batches}
                onCompare={openComparison}
                onSelectNode={setSelectedNodeId}
                selectedNodeId={selectedNodeId}
                snapshot={snapshot}
              />
            ) : comparisonBatch ? (
              <OrchestrationComparisonView
                batch={comparisonBatch}
                onToggle={(key) => setSelectedArmKeys(toggleComparisonSelection(armKeys, key))}
                selectedKeys={armKeys}
              />
            ) : null}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
