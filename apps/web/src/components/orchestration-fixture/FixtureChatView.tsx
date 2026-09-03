/**
 * Thread view for fixture threads: header, transcript, composer, and the
 * production Work panel fed by the fixture's virtual environment.
 *
 * Structurally the same shape as ChatView so density can be judged, but with
 * no sockets or live stores; every fact comes from the reduced scenario. The
 * Work panel, Compare surface and coordination strip are the real components,
 * so what is reviewed here is what ships.
 */
import { Network, SendHorizontal, X } from "lucide-react";
import { useMemo, useState } from "react";

import { isElectron } from "~/env";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../../rightPanelLayout";
import { RightPanelSheet } from "../RightPanelSheet";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { CompareColumnDataContext } from "../work/compareData";
import { CoordinationStrip } from "../work/CoordinationStrip";
import { WorkPanel, type WorkActions } from "../work/WorkPanel";
import { cn } from "~/lib/utils";
import { useFixtureActions } from "./actions";
import { useFixtureCompareColumn } from "./compareColumn";
import { fixtureThreadKey, fixtureThreadRef } from "./fixtureEnvironment";
import { displayLabel, projectTitle, statusVisual } from "./presentation";
import { isWaiting } from "./reducer";
import { StepStrip } from "./StepStrip";
import { useFixtureState, useOrchestrationFixtureStore } from "./store";
import { TranscriptItem } from "./transcript";

function Composer({ threadId, label }: { readonly threadId: string; readonly label: string }) {
  const actions = useFixtureActions();
  const [draft, setDraft] = useState("");
  const submit = () => {
    const text = draft.trim();
    if (text.length === 0) return;
    actions.sendMessage(threadId, text);
    setDraft("");
  };
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-3">
      <div className="rounded-[22px] border border-border/70 bg-card shadow-[0_12px_28px_-18px_rgb(0_0_0/40%)] dark:bg-surface-raised dark:shadow-none">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={`Message ${label}`}
          aria-label={`Message ${label}`}
          rows={2}
          className="min-h-0 resize-none border-0 bg-transparent px-4 pt-3 pb-1 text-sm shadow-none focus-visible:ring-0"
        />
        <div className="flex items-center gap-2 px-3 pb-2">
          <span className="text-[.7rem] text-muted-foreground">
            Sending appends a turn to the fixture; nothing leaves this page.
          </span>
          <Button
            size="icon-xs"
            className="ml-auto"
            aria-label="Send"
            onClick={submit}
            disabled={draft.trim().length === 0}
          >
            <SendHorizontal />
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Human corrections routed into the fixture reducer instead of server verbs. */
function useFixtureWorkActions(): WorkActions {
  const actions = useFixtureActions();
  const state = useFixtureState();
  return useMemo<WorkActions>(
    () => ({
      moveToEffort: (ref, effortId) => actions.moveToEffort(ref.threadId, effortId),
      closeEffort: (effortId, stopMembers) => actions.closeEffort(effortId, stopMembers),
      reopenEffort: (effortId) => actions.reopenEffort(effortId),
      cancelWait: (waitId) => actions.cancelWait(waitId),
      stopThread: (ref) => actions.stopThread(ref.threadId),
      retryThread: (ref) => actions.retryThread(state, ref.threadId),
    }),
    [actions, state],
  );
}

export function FixtureChatView({ threadId }: { readonly threadId: string }) {
  const state = useFixtureState();
  const panelOpen = useOrchestrationFixtureStore((store) => store.panelOpen);
  const setPanelOpen = useOrchestrationFixtureStore((store) => store.setPanelOpen);
  const narrow = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const workActions = useFixtureWorkActions();
  const thread = state.threads[threadId];
  const threadRef = fixtureThreadRef(threadId);

  if (thread === undefined) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        This thread does not exist at the current step.
      </div>
    );
  }

  const visual = statusVisual(thread.status);
  const waiting = isWaiting(state, threadId) && thread.status === "completed";
  const label = displayLabel(state, threadId);

  const panel = (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <span className="flex h-6 items-center gap-1 rounded-md bg-accent px-2 text-xs text-foreground">
          <Network aria-hidden className="size-3" />
          Work
        </span>
        <span className="flex-1" />
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Close panel"
          onClick={() => setPanelOpen(false)}
        >
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <CompareColumnDataContext value={useFixtureCompareColumn}>
          <WorkPanel threadRef={threadRef} actions={workActions} />
        </CompareColumnDataContext>
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-thread-key={fixtureThreadKey(threadId)}>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <WorkspacePageHeader electron={isElectron} className="border-b border-border/60">
            <WorkspaceBreadcrumb ariaLabel="Thread location">
              <WorkspaceBreadcrumbItem>
                {projectTitle(state, thread.projectId)}
              </WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbSeparator />
              <WorkspaceBreadcrumbItem current>{thread.title}</WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            <span
              className={cn(
                "ml-2 shrink-0 text-xs font-medium",
                waiting ? "text-sky-600 dark:text-sky-400" : visual.textClass,
              )}
            >
              {waiting ? "Monitoring" : thread.status === "completed" ? "Ready" : visual.label}
            </span>
            <span className="flex-1" />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant={panelOpen ? "secondary" : "ghost-muted"}
                    aria-label={panelOpen ? "Close Work panel" : "Open Work panel"}
                    onClick={() => setPanelOpen(!panelOpen)}
                  />
                }
              >
                <Network />
              </TooltipTrigger>
              <TooltipPopup>Work</TooltipPopup>
            </Tooltip>
          </WorkspacePageHeader>
          <CoordinationStrip threadRef={threadRef} onOpenWork={() => setPanelOpen(true)} />
          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
              {thread.timeline.map((item) => (
                <TranscriptItem key={item.id} state={state} thread={thread} item={item} />
              ))}
              {thread.status === "running" ? (
                <div className="flex items-center gap-2 text-xs text-sky-600 dark:text-sky-400">
                  <span aria-hidden className="size-1.5 rounded-full bg-info" />
                  <span>{thread.activity ?? "Working"}</span>
                </div>
              ) : null}
            </div>
          </ScrollArea>
          <Composer threadId={threadId} label={label} />
        </div>
        {panelOpen && !narrow ? (
          <aside className="flex w-[min(42vw,28rem)] min-w-80 shrink-0 flex-col border-s border-border/60">
            {panel}
          </aside>
        ) : null}
        {narrow ? (
          <RightPanelSheet
            animationDurationMs={0}
            open={panelOpen}
            onClose={() => setPanelOpen(false)}
          >
            {panel}
          </RightPanelSheet>
        ) : null}
      </div>
      <StepStrip />
    </div>
  );
}
