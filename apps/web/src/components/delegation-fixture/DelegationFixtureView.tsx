/**
 * `/fixtures/delegation` — the whole delegation surface in three frozen states.
 *
 * Nothing here subscribes, polls or ticks. The segmented control swaps between
 * three static snapshots so the row, the settled strip, the Agents-panel batch
 * group and Compare can be reviewed side by side without a live batch.
 *
 * The right panel follows the same rules as the real one: an aside on desktop
 * (maximizable while comparing, because two columns of diff want the room), a
 * sheet below the inline breakpoint, and every way in has a way back out.
 */
import { Bot, Columns2, Maximize2, Minimize2, X } from "lucide-react";
import { useState, type ReactNode } from "react";

import { isElectron } from "~/env";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "~/rightPanelLayout";
import { RightPanelSheet } from "../RightPanelSheet";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { AgentsPanelBatchGroup } from "./AgentsPanelBatchGroup";
import { CompareSurface } from "./CompareSurface";
import { COMPARE_COLUMN_COUNT } from "./DelegationResultStrip";
import { DelegationRow } from "./DelegationRow";
import {
  DEFAULT_COMPARE_KEYS,
  DELEGATION_FIXTURE_STATES,
  DELEGATION_PHASES,
  DELEGATION_PHASE_LABELS,
  DELEGATION_PROMPT,
  isDelegationPhase,
} from "./fixtureData";
import { useDelegationFixtureStore } from "./fixtureState";

type PanelSurface = "agents" | "compare";

/** Click order is not column order, so selection is a set and Compare re-derives. */
function toggleKey(keys: readonly string[], key: string): readonly string[] {
  return keys.includes(key) ? keys.filter((entry) => entry !== key) : [...keys, key];
}

function UserMessage({ text }: { readonly text: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground text-sm leading-relaxed">
        {text}
      </p>
    </div>
  );
}

function AssistantMessage({ text }: { readonly text: string }) {
  return <p className="text-foreground text-sm leading-relaxed">{text}</p>;
}

function PanelChrome({
  surface,
  onSelectSurface,
  compareEnabled,
  maximized,
  onToggleMaximize,
  onClose,
  children,
}: {
  readonly surface: PanelSurface;
  readonly onSelectSurface: (next: PanelSurface) => void;
  readonly compareEnabled: boolean;
  /** Null hides the control: the sheet is already full width, Agents needs no room. */
  readonly maximized: boolean | null;
  readonly onToggleMaximize: () => void;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center gap-2 border-border/60 border-b px-2 py-1.5">
        <ToggleGroup
          aria-label="Panel surface"
          onValueChange={(next) => {
            const value = next[0];
            if (value === "agents" || value === "compare") onSelectSurface(value);
          }}
          value={[surface]}
          variant="segmented"
        >
          <Toggle value="agents">
            <Bot aria-hidden />
            Agents
          </Toggle>
          <Toggle disabled={!compareEnabled} value="compare">
            <Columns2 aria-hidden />
            Compare
          </Toggle>
        </ToggleGroup>
        <div className="ms-auto flex shrink-0 items-center gap-1">
          {maximized === null ? null : (
            <Button
              aria-label={maximized ? "Restore panel width" : "Maximize panel"}
              onClick={onToggleMaximize}
              size="icon-xs"
              variant="ghost-muted"
            >
              {maximized ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
            </Button>
          )}
          <Button aria-label="Close panel" onClick={onClose} size="icon-xs" variant="ghost-muted">
            <X aria-hidden />
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

export function DelegationFixtureView() {
  const phase = useDelegationFixtureStore((state) => state.phase);
  const setPhase = useDelegationFixtureStore((state) => state.setPhase);
  const [surface, setSurface] = useState<PanelSurface>("agents");
  // The desktop aside starts open; the mobile sheet does not open itself over
  // the transcript before the reviewer has asked for it.
  const [panelOpen, setPanelOpen] = useState(
    () =>
      typeof window === "undefined" ||
      !window.matchMedia(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY).matches,
  );
  const [maximized, setMaximized] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<readonly string[]>(DEFAULT_COMPARE_KEYS);
  const [focusedWorkerKey, setFocusedWorkerKey] = useState<string | null>(null);

  const inlineLayout = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const state = DELEGATION_FIXTURE_STATES[phase];
  const compareWorkers = state.workers.filter((worker) => selectedKeys.includes(worker.key));
  const compareEnabled = phase === "settled" && compareWorkers.length === COMPARE_COLUMN_COUNT;
  const activeSurface: PanelSurface = surface === "compare" && !compareEnabled ? "agents" : surface;
  // Maximizing is a Compare affordance — two columns of diff want the room —
  // so it is derived, not stored. Falling back to Agents (a deselected result,
  // a phase change) restores the transcript without clearing the preference.
  const canMaximize = !inlineLayout && activeSurface === "compare";
  const showMaximized = canMaximize && maximized;

  const selectPhase = (next: string) => {
    if (!isDelegationPhase(next)) return;
    setPhase(next);
    setFocusedWorkerKey(null);
    // Compare only exists once results do; leaving the settled state has to
    // leave the surface too rather than stranding an empty panel.
    if (next !== "settled") setSurface("agents");
  };

  const openWorker = (key: string) => {
    // In the product this navigates to the child thread. The fixture has no
    // threads to navigate to, so it points at the lane that owns the worker.
    setFocusedWorkerKey(key);
    setSurface("agents");
    setPanelOpen(true);
  };

  const panelBody =
    activeSurface === "compare" ? (
      <CompareSurface variant={inlineLayout ? "tabs" : "columns"} workers={compareWorkers} />
    ) : (
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-2">
          <AgentsPanelBatchGroup
            state={state}
            focusedWorkerKey={focusedWorkerKey}
            onOpenWorker={openWorker}
          />
        </div>
      </ScrollArea>
    );

  const panelContent = (
    <PanelChrome
      surface={activeSurface}
      onSelectSurface={setSurface}
      compareEnabled={compareEnabled}
      maximized={canMaximize ? showMaximized : null}
      onToggleMaximize={() => setMaximized((value) => !value)}
      onClose={() => setPanelOpen(false)}
    >
      {panelBody}
    </PanelChrome>
  );

  const desktopPanelOpen = panelOpen && !inlineLayout;

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Fixture breadcrumb" className="hidden min-w-0 sm:flex">
            <WorkspaceBreadcrumbItem>
              <span>Fixtures</span>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current>
              <h1>Delegation</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="ms-auto flex shrink-0 items-center gap-2">
            <ToggleGroup
              aria-label="Delegation state"
              onValueChange={(next) => {
                const value = next[0];
                if (typeof value === "string") selectPhase(value);
              }}
              value={[phase]}
              variant="segmented"
            >
              {DELEGATION_PHASES.map((option) => (
                <Toggle key={option} value={option}>
                  {DELEGATION_PHASE_LABELS[option]}
                </Toggle>
              ))}
            </ToggleGroup>
            {panelOpen ? null : (
              <Button onClick={() => setPanelOpen(true)} size="compact" variant="outline">
                <Bot aria-hidden />
                Agents
              </Button>
            )}
          </div>
        </WorkspacePageHeader>

        <div className="flex min-h-0 min-w-0 flex-1">
          {desktopPanelOpen && showMaximized ? null : (
            <ScrollArea className="min-h-0 min-w-0 flex-1">
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-5 pt-6 pb-12 sm:px-6">
                <UserMessage text={DELEGATION_PROMPT} />
                <DelegationRow
                  task={state.task}
                  workers={state.workers}
                  phase={state.phase}
                  counts={state.counts}
                  elapsed={state.elapsed}
                  onOpenBatch={() => {
                    setSurface("agents");
                    setFocusedWorkerKey(null);
                    setPanelOpen(true);
                  }}
                  selectedKeys={selectedKeys}
                  onToggleSelection={(key) => setSelectedKeys((keys) => toggleKey(keys, key))}
                  onCompare={() => {
                    setSurface("compare");
                    setPanelOpen(true);
                  }}
                  onOpenWorker={openWorker}
                />
                {state.assessment ? <AssistantMessage text={state.assessment} /> : null}
              </div>
            </ScrollArea>
          )}
          {desktopPanelOpen ? (
            <aside
              aria-label="Delegation panel"
              className={cn(
                "flex min-h-0 shrink-0 flex-col border-border/60 border-s",
                showMaximized ? "w-full flex-1" : "w-[24rem] xl:w-[28rem]",
              )}
            >
              {panelContent}
            </aside>
          ) : null}
        </div>
      </div>
      {inlineLayout ? (
        <RightPanelSheet open={panelOpen} onClose={() => setPanelOpen(false)}>
          {panelContent}
        </RightPanelSheet>
      ) : null}
    </SidebarInset>
  );
}
