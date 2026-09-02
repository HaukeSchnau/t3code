import {
  ArrowRightIcon,
  CheckIcon,
  Clock3Icon,
  LoaderCircleIcon,
  MessageSquareTextIcon,
  PinIcon,
  ShieldCheckIcon,
  XIcon,
} from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  type ApprovalRequestId,
  type ProviderInstanceId,
  type ProviderApprovalDecision,
  type ScopedThreadRef,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type LegendListRef } from "@legendapp/list/react";

import {
  deriveActiveWorkStartedAt,
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  isLatestTurnSettled,
  type PendingApproval,
  type PendingUserInput,
} from "../session-logic";
import { readEnvironmentApi } from "../environmentApi";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import { cn, newCommandId, newMessageId } from "../lib/utils";
import { type ElementContextDraft } from "../lib/elementContext";
import { type TerminalContextDraft } from "../lib/terminalContext";
import { resolveAppModelSelectionForInstance } from "../modelSelection";
import {
  buildPendingUserInputAnswers,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "../types";
import { getStartedThreadModelChangeBlockReason } from "./ChatView.logic";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import {
  type ComposerImageAttachment,
  type ComposerThreadDraftState,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "../composerDraftStore";
import { ChatComposer, type ChatComposerHandle } from "./chat/ChatComposer";
import { ExpandedImageDialog } from "./chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import { QueuedMessagesStrip } from "./chat/QueuedMessagesStrip";
import {
  analyzeThreadTurnDraft,
  createDirectThreadTurnDeliveryAdapter,
  resolveFollowUpSubmissionTitle,
  submitThreadTurn,
  threadComposerRevision,
  threadTurnDraftFromComposer,
} from "./chat/ThreadTurnSubmission";
import { useThreadQueuedMessageControls } from "./chat/useThreadDurableOutbox";
import { useProjects, useProviderUsageLimits, useThread } from "../state/entities";
import { primaryServerConfigAtom, primaryServerKeybindingsAtom } from "../state/server";
import { useSidebarCardThreads } from "./sidebar/SidebarCardThreadsContext";

type SidebarThreadSummary = EnvironmentThreadShell;
type Thread = EnvironmentThread;

/** Monitor is a live dashboard: it intentionally renders hot/latest activity only. */
export function deriveMonitorTimelineEntries(
  thread: Pick<Thread, "messages" | "proposedPlans" | "activities">,
) {
  return deriveTimelineEntries(
    thread.messages,
    thread.proposedPlans,
    deriveWorkLogEntries(thread.activities),
  );
}

const MONITOR_ORDER_STORAGE_KEY = "t3code.monitor.threadOrder.v1";
const EMPTY_TURN_DIFFS = new Map();
const EMPTY_REVERT_COUNTS = new Map();
const EMPTY_PROVIDER_SKILLS: [] = [];
const EMPTY_RESPONDING_REQUEST_IDS: [] = [];
const EMPTY_PENDING_DRAFT_ANSWERS = {};
const MONITOR_GRID_GAP_PX = 8;
const MONITOR_TILE_TARGET_MIN_WIDTH_PX = 420;
const MONITOR_TILE_TARGET_ASPECT_RATIO = 1.3;

export type MonitorThreadReason = "actionable" | "error" | "running" | "plan" | "ready";

export interface MonitorThreadCandidate {
  thread: SidebarThreadSummary;
  key: string;
  reason: MonitorThreadReason;
  priority: number;
  timestamp: number;
}

type MonitorGridStyle = CSSProperties & {
  "--monitor-grid-columns": number;
};

function hasMonitorComposerDraftContent(draft: ComposerThreadDraftState): boolean {
  return (
    draft.prompt.trim().length > 0 ||
    draft.images.length > 0 ||
    draft.persistedAttachments.length > 0 ||
    draft.terminalContexts.length > 0 ||
    draft.elementContexts.length > 0 ||
    draft.previewAnnotations.length > 0
  );
}

function hasOpenFloatingComposerControl(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(
    document.querySelector(
      [
        '[role="listbox"]',
        '[role="menu"]',
        "[data-floating-ui-portal]",
        "[data-radix-popper-content-wrapper]",
      ].join(","),
    ),
  );
}

function readStoredOrder(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(MONITOR_ORDER_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function writeStoredOrder(order: readonly string[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(MONITOR_ORDER_STORAGE_KEY, JSON.stringify(order));
}

function toTimestamp(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

function isLiveSessionStatus(
  status: NonNullable<SidebarThreadSummary["session"]>["status"] | undefined,
): boolean {
  return status === "starting" || status === "running";
}

function isThreadSessionLive(
  session: Thread["session"] | SidebarThreadSummary["session"],
): boolean {
  return isLiveSessionStatus(session?.status);
}

function isSupersededSessionError(
  session: Thread["session"] | SidebarThreadSummary["session"],
  latestTurn: SidebarThreadSummary["latestTurn"],
): boolean {
  if (!session || latestTurn?.state !== "completed" || !latestTurn.completedAt) {
    return false;
  }
  const sessionUpdatedAt = toTimestamp(session.updatedAt);
  const turnCompletedAt = toTimestamp(latestTurn.completedAt);
  return Number.isFinite(sessionUpdatedAt) && turnCompletedAt > sessionUpdatedAt;
}

function isActiveSessionError(
  session: Thread["session"] | SidebarThreadSummary["session"],
  latestTurn: SidebarThreadSummary["latestTurn"],
): boolean {
  const status = session?.status;
  if (status !== "error" && status !== "interrupted") {
    return false;
  }
  return !isSupersededSessionError(session, latestTurn);
}

function hasPlanReadyPrompt(thread: SidebarThreadSummary): boolean {
  return (
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    thread.hasActionableProposedPlan
  );
}

export function resolveMonitorThreadCandidate(
  thread: SidebarThreadSummary,
): MonitorThreadCandidate {
  const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const latestTurn = thread.latestTurn;
  const actionable = thread.hasPendingApprovals || thread.hasPendingUserInput;
  const planReady = hasPlanReadyPrompt(thread);
  const hasError =
    latestTurn?.state === "error" ||
    latestTurn?.state === "interrupted" ||
    isActiveSessionError(thread.session, latestTurn);
  const sessionStatus = thread.session?.status;
  const running = isLiveSessionStatus(sessionStatus);

  const reason: MonitorThreadReason = actionable
    ? "actionable"
    : hasError
      ? "error"
      : running
        ? "running"
        : planReady
          ? "plan"
          : "ready";
  const priority =
    reason === "actionable"
      ? 0
      : reason === "error"
        ? 1
        : reason === "running"
          ? 2
          : reason === "plan"
            ? 3
            : 4;
  const timestamp = Math.max(
    toTimestamp(thread.latestUserMessageAt),
    toTimestamp(latestTurn?.startedAt),
    toTimestamp(latestTurn?.completedAt),
    toTimestamp(thread.updatedAt),
    toTimestamp(thread.createdAt),
  );

  return { thread, key, reason, priority, timestamp };
}

function sortCandidatesForInitialPlacement(
  candidates: readonly MonitorThreadCandidate[],
): MonitorThreadCandidate[] {
  return [...candidates].sort((left, right) => {
    if (left.priority !== right.priority) return left.priority - right.priority;
    if (left.timestamp !== right.timestamp) return right.timestamp - left.timestamp;
    return left.key.localeCompare(right.key);
  });
}

function formatElapsed(startedAt: string | null | undefined): string | null {
  if (!startedAt) return null;
  const elapsed = Date.now() - Date.parse(startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function reasonLabel(reason: MonitorThreadReason): string {
  switch (reason) {
    case "actionable":
      return "Needs input";
    case "error":
      return "Blocked";
    case "running":
      return "Running";
    case "plan":
      return "Plan ready";
    case "ready":
      return "Ready";
  }
}

function reasonClassName(reason: MonitorThreadReason): string {
  switch (reason) {
    case "actionable":
      return "border-amber-400/40 bg-amber-500/10 text-amber-700 dark:text-amber-200";
    case "error":
      return "border-red-400/40 bg-red-500/10 text-red-700 dark:text-red-200";
    case "running":
      return "border-sky-400/40 bg-sky-500/10 text-sky-700 dark:text-sky-200";
    case "plan":
      return "border-violet-400/40 bg-violet-500/10 text-violet-700 dark:text-violet-200";
    case "ready":
      return "border-border bg-muted/40 text-muted-foreground";
  }
}

function pickMonitorGridColumnCount(count: number, width: number, height: number): number {
  if (count <= 1 || width <= 0 || height <= 0) return 1;

  const maxColumns = Math.max(
    1,
    Math.min(
      count,
      Math.floor(
        (width + MONITOR_GRID_GAP_PX) / (MONITOR_TILE_TARGET_MIN_WIDTH_PX + MONITOR_GRID_GAP_PX),
      ),
    ),
  );
  let bestColumns = 1;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let columns = 1; columns <= maxColumns; columns += 1) {
    const rows = Math.ceil(count / columns);
    const emptyCells = columns * rows - count;
    const tileWidth = (width - MONITOR_GRID_GAP_PX * (columns - 1)) / columns;
    const tileHeight = (height - MONITOR_GRID_GAP_PX * (rows - 1)) / rows;
    const aspectRatio = tileWidth / Math.max(1, tileHeight);
    const aspectScore = Math.abs(Math.log(aspectRatio / MONITOR_TILE_TARGET_ASPECT_RATIO));
    const sparseLastRowScore = emptyCells * 1.4;
    const singleColumnScore = columns === 1 && count > 1 ? 0.5 : 0;
    const score = aspectScore + sparseLastRowScore + singleColumnScore;

    if (score < bestScore) {
      bestScore = score;
      bestColumns = columns;
    }
  }

  return bestColumns;
}

function useMonitorGridColumns(count: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [columns, setColumns] = useState(1);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const updateColumns = () => {
      const nextColumns = pickMonitorGridColumnCount(
        count,
        element.clientWidth,
        element.clientHeight,
      );
      setColumns((current) => (current === nextColumns ? current : nextColumns));
    };

    updateColumns();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateColumns);
      return () => window.removeEventListener("resize", updateColumns);
    }

    const observer = new ResizeObserver(updateColumns);
    observer.observe(element);
    return () => observer.disconnect();
  }, [count]);

  return [ref, columns] as const;
}

function useStableMonitorCandidates(threads: readonly SidebarThreadSummary[]) {
  const [order, setOrder] = useState<string[]>(() => readStoredOrder());
  const candidates = useMemo(
    () => threads.map((thread) => resolveMonitorThreadCandidate(thread)),
    [threads],
  );

  useEffect(() => {
    setOrder((existing) => {
      const candidateByKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
      const retained = existing.filter((key) => candidateByKey.has(key));
      const retainedSet = new Set(retained);
      const added = sortCandidatesForInitialPlacement(candidates)
        .map((candidate) => candidate.key)
        .filter((key) => !retainedSet.has(key));
      const next = [...retained, ...added];
      if (next.length === existing.length && next.every((key, index) => key === existing[index])) {
        return existing;
      }
      writeStoredOrder(next);
      return next;
    });
  }, [candidates]);

  return useMemo(() => {
    const candidateByKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
    if (order.length === 0) {
      return sortCandidatesForInitialPlacement(candidates);
    }
    return order.flatMap((key) => {
      const candidate = candidateByKey.get(key);
      return candidate ? [candidate] : [];
    });
  }, [candidates, order]);
}

function useTileVisibility() {
  const ref = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        setVisible(Boolean(entry?.isIntersecting));
      },
      { root: null, rootMargin: "280px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, visible] as const;
}

function useRetainedThreadDetail(threadRef: ScopedThreadRef, enabled: boolean): Thread | undefined {
  const thread = useThread(enabled ? threadRef : null);
  return thread ?? undefined;
}

export function MonitorView() {
  const sidebarCardThreads = useSidebarCardThreads();
  const candidates = useStableMonitorCandidates(sidebarCardThreads ?? []);
  const [gridViewportRef, gridColumns] = useMonitorGridColumns(candidates.length);
  const gridStyle = useMemo<MonitorGridStyle>(
    () => ({ "--monitor-grid-columns": gridColumns }),
    [gridColumns],
  );

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <div className="flex min-h-0 flex-1 flex-col">
        {candidates.length === 0 ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyTitle>No active threads</EmptyTitle>
              <EmptyDescription>
                Non-settled, non-snoozed threads will appear here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div
            ref={gridViewportRef}
            className="monitor-grid min-h-0 flex-1 overflow-auto p-2 sm:p-3"
          >
            <div
              className="grid h-full min-h-full auto-rows-[minmax(22rem,1fr)] grid-cols-[repeat(var(--monitor-grid-columns),minmax(0,1fr))] gap-1.5 sm:gap-2"
              style={gridStyle}
            >
              {candidates.map((candidate) => (
                <MonitorThreadTile key={candidate.key} candidate={candidate} />
              ))}
            </div>
          </div>
        )}
      </div>
    </SidebarInset>
  );
}

const MonitorThreadTile = memo(function MonitorThreadTile({
  candidate,
}: {
  candidate: MonitorThreadCandidate;
}) {
  const threadRef = useMemo(
    () => scopeThreadRef(candidate.thread.environmentId, candidate.thread.id),
    [candidate.thread.environmentId, candidate.thread.id],
  );
  const [tileRef, tileVisible] = useTileVisibility();
  const thread = useRetainedThreadDetail(threadRef, tileVisible);
  const projects = useProjects();
  const project = useMemo(
    () =>
      thread
        ? projects.find(
            (candidate) =>
              candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
          )
        : undefined,
    [projects, thread],
  );
  const routeThreadKey = scopedThreadKey(threadRef);
  const running =
    isThreadSessionLive(thread?.session ?? null) || isThreadSessionLive(candidate.thread.session);
  const activitySession = isThreadSessionLive(thread?.session ?? null)
    ? (thread?.session ?? null)
    : candidate.thread.session;
  const latestTurnSettled = isLatestTurnSettled(
    thread?.latestTurn ?? candidate.thread.latestTurn,
    activitySession,
  );
  const activeTurnStartedAt = running
    ? deriveActiveWorkStartedAt(
        thread?.latestTurn ?? candidate.thread.latestTurn,
        activitySession,
        null,
      )
    : null;
  const elapsed = formatElapsed(activeTurnStartedAt);

  return (
    <section
      ref={tileRef}
      className={cn(
        "group/tile flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card/48 shadow-sm/5",
        candidate.reason === "actionable"
          ? "border-amber-400/35"
          : candidate.reason === "error"
            ? "border-red-400/35"
            : "border-border/70",
      )}
      data-testid="monitor-thread-tile"
    >
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border/60 px-2.5 py-2">
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
            reasonClassName(candidate.reason),
          )}
        >
          {running ? <LoaderCircleIcon className="size-3 animate-spin" /> : null}
          {reasonLabel(candidate.reason)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-foreground/92">
            {candidate.thread.title}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground/60">
            <span className="truncate">{project?.title ?? "Unknown project"}</span>
            {elapsed ? (
              <>
                <span className="text-muted-foreground/30">/</span>
                <span className="inline-flex items-center gap-1 tabular-nums">
                  <Clock3Icon className="size-3" />
                  {elapsed}
                </span>
              </>
            ) : null}
          </div>
        </div>
        <Button
          render={
            <Link
              to="/$environmentId/$threadId"
              params={{
                environmentId: candidate.thread.environmentId,
                threadId: candidate.thread.id,
              }}
            />
          }
          size="icon-xs"
          variant="ghost"
          aria-label="Open full thread"
        >
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>

      <MonitorThreadBody
        thread={thread}
        shellThread={candidate.thread}
        visible={tileVisible}
        threadRef={threadRef}
        routeThreadKey={routeThreadKey}
        isWorking={running}
        activeTurnInProgress={running && !latestTurnSettled}
        activeTurnStartedAt={activeTurnStartedAt}
        projectCwd={project?.workspaceRoot}
      />

      <MonitorThreadActions
        thread={thread}
        fallbackThread={candidate.thread}
        threadRef={threadRef}
      />
    </section>
  );
});

function MonitorThreadBody({
  thread,
  shellThread,
  visible,
  threadRef,
  routeThreadKey,
  isWorking,
  activeTurnInProgress,
  activeTurnStartedAt,
  projectCwd,
}: {
  thread: Thread | undefined;
  shellThread: SidebarThreadSummary;
  visible: boolean;
  threadRef: ScopedThreadRef;
  routeThreadKey: string;
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  projectCwd: string | undefined;
}) {
  const listRef = useRef<LegendListRef | null>(null);
  const timestampFormat = useEnvironmentSettings(
    threadRef.environmentId,
    (settings) => settings.timestampFormat,
  );
  const { resolvedTheme } = useTheme();
  const timelineEntries = useMemo(
    () => (thread ? deriveMonitorTimelineEntries(thread) : []),
    [thread],
  );
  const turnDiffSummaryByAssistantMessageId = EMPTY_TURN_DIFFS;

  if (!visible) {
    return (
      <div className="flex min-h-0 flex-1 flex-col justify-between p-2.5 text-xs text-muted-foreground/70">
        <div>
          <p className="font-medium text-foreground/75">{shellThread.title}</p>
          <p className="mt-1">Thread detail will hydrate when this tile scrolls into view.</p>
        </div>
        <div className="rounded-md border border-border/60 bg-muted/25 px-2 py-1 text-[11px]">
          {shellThread.session?.status ?? shellThread.latestTurn?.state ?? "idle"}
        </div>
      </div>
    );
  }

  if (!thread) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground/65">
        Loading thread...
      </div>
    );
  }

  return (
    <div className="monitor-tile-transcript relative min-h-0 flex-1 text-[12px]">
      <MessagesTimeline
        isWorking={isWorking}
        activeTurnInProgress={activeTurnInProgress}
        activeTurnStartedAt={activeTurnStartedAt}
        listRef={listRef}
        timelineEntries={timelineEntries}
        latestTurn={thread.latestTurn}
        runningTurnId={thread.latestTurn?.state === "running" ? thread.latestTurn.turnId : null}
        turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
        routeThreadKey={routeThreadKey}
        onOpenTurnDiff={() => undefined}
        revertTurnCountByUserMessageId={EMPTY_REVERT_COUNTS}
        onRevertUserMessage={() => undefined}
        isRevertingCheckpoint={false}
        onImageExpand={() => undefined}
        activeThreadEnvironmentId={threadRef.environmentId}
        canForkAssistantMessage={false}
        markdownCwd={thread.worktreePath ?? projectCwd}
        resolvedTheme={resolvedTheme}
        timestampFormat={timestampFormat}
        workspaceRoot={projectCwd}
        skills={EMPTY_PROVIDER_SKILLS}
        anchorMessageId={null}
        onAnchorReady={() => undefined}
        contentInsetEndAdjustment={0}
        liveFollowEnabled={false}
        onIsAtEndChange={() => undefined}
        onManualNavigation={() => undefined}
      />
    </div>
  );
}

function MonitorThreadActions({
  thread,
  fallbackThread,
  threadRef,
}: {
  thread: Thread | undefined;
  fallbackThread: SidebarThreadSummary;
  threadRef: ScopedThreadRef;
}) {
  const pendingApprovals = useMemo(
    () => (thread ? derivePendingApprovals(thread.activities) : []),
    [thread],
  );
  const pendingUserInputs = useMemo(
    () => (thread ? derivePendingUserInputs(thread.activities) : []),
    [thread],
  );
  const settings = useEnvironmentSettings(threadRef.environmentId);
  const { resolvedTheme } = useTheme();
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const providerStatuses = useMemo<ServerProvider[]>(
    () => [...(serverConfig?.providers ?? [])],
    [serverConfig?.providers],
  );
  const projects = useProjects();
  const activeProject = useMemo(
    () =>
      thread
        ? projects.find(
            (candidate) =>
              candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
          )
        : undefined,
    [projects, thread],
  );
  const providerUsageLimits = useProviderUsageLimits(threadRef.environmentId);
  const usageLimitsSources = useMemo(
    () =>
      providerUsageLimits.map((entry) => ({
        provider: entry.provider,
        providerInstanceId: entry.providerInstanceId,
        usageLimits: [entry.usageLimits],
        usageHistory: entry.history,
      })),
    [providerUsageLimits],
  );
  const composerRuntimeMode = useComposerDraftStore(
    (store) => store.getComposerDraft(threadRef)?.runtimeMode ?? null,
  );
  const composerInteractionMode = useComposerDraftStore(
    (store) => store.getComposerDraft(threadRef)?.interactionMode ?? null,
  );
  const composerDraft = useComposerThreadDraft(threadRef);
  const composerHasDraftContent = hasMonitorComposerDraftContent(composerDraft);
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const promptRef = useRef("");
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const composerElementContextsRef = useRef<ElementContextDraft[]>([]);
  const composerRef = useRef<ChatComposerHandle | null>(null);
  const composerShellRef = useRef<HTMLDivElement | null>(null);
  const collapsedComposerButtonRef = useRef<HTMLButtonElement | null>(null);
  const composerHasDraftContentRef = useRef(composerHasDraftContent);
  const busyRef = useRef(false);
  const errorRef = useRef<string | null>(null);
  const focusComposerAfterExpandRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const runtimeMode = composerRuntimeMode ?? thread?.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode =
    composerInteractionMode ?? thread?.interactionMode ?? DEFAULT_INTERACTION_MODE;
  const isRunning =
    isThreadSessionLive(thread?.session ?? null) || isThreadSessionLive(fallbackThread.session);
  const phase = isRunning ? "running" : "ready";
  const forceComposerExpanded = composerHasDraftContent || busy || error !== null;
  const showComposer = composerExpanded || forceComposerExpanded;

  useEffect(() => {
    composerHasDraftContentRef.current = composerHasDraftContent;
  }, [composerHasDraftContent]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    errorRef.current = error;
  }, [error]);

  const focusComposer = useCallback(() => {
    window.requestAnimationFrame(() => composerRef.current?.focusAtEnd());
  }, []);

  useEffect(() => {
    focusComposerAfterExpandRef.current = false;
    setComposerExpanded(false);
  }, [threadRef.environmentId, threadRef.threadId]);

  useEffect(() => {
    if (forceComposerExpanded) {
      setComposerExpanded(true);
    }
  }, [forceComposerExpanded]);

  useEffect(() => {
    if (!showComposer || !focusComposerAfterExpandRef.current) return;
    focusComposerAfterExpandRef.current = false;
    focusComposer();
  }, [focusComposer, showComposer]);

  const expandComposer = useCallback(
    (options: { focus?: boolean } = {}) => {
      focusComposerAfterExpandRef.current = options.focus ?? true;
      setComposerExpanded(true);
      if (showComposer && focusComposerAfterExpandRef.current) {
        focusComposerAfterExpandRef.current = false;
        focusComposer();
      }
    },
    [focusComposer, showComposer],
  );

  const collapseComposerIfIdle = useCallback((options: { restoreFocus?: boolean } = {}) => {
    if (composerHasDraftContentRef.current || busyRef.current || errorRef.current) return;
    if (composerRef.current?.isModelPickerOpen()) return;
    if (hasOpenFloatingComposerControl()) return;
    focusComposerAfterExpandRef.current = false;
    setComposerExpanded(false);
    if (options.restoreFocus) {
      window.requestAnimationFrame(() => collapsedComposerButtonRef.current?.focus());
    }
  }, []);

  const scheduleCollapseComposerIfIdle = useCallback(() => {
    window.setTimeout(() => {
      const shell = composerShellRef.current;
      const activeElement = document.activeElement;
      if (shell && activeElement instanceof Node && shell.contains(activeElement)) return;
      collapseComposerIfIdle();
    }, 120);
  }, [collapseComposerIfIdle]);

  const handleExpandedComposerBlur = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
      scheduleCollapseComposerIfIdle();
    },
    [scheduleCollapseComposerIfIdle],
  );

  const handleExpandedComposerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const wasExpanded = composerExpanded;
      collapseComposerIfIdle({ restoreFocus: true });
      if (
        wasExpanded &&
        !composerHasDraftContentRef.current &&
        !busyRef.current &&
        !errorRef.current
      ) {
        event.stopPropagation();
      }
    },
    [collapseComposerIfIdle, composerExpanded],
  );

  const handleQueuedStripClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("button,a,input,textarea,select,[role='button']")) return;
      expandComposer();
    },
    [expandComposer],
  );

  const handleRuntimeModeChange = useCallback(
    (mode: typeof runtimeMode) => {
      setComposerDraftRuntimeMode(threadRef, mode);
      focusComposer();
    },
    [focusComposer, setComposerDraftRuntimeMode, threadRef],
  );

  const handleInteractionModeChange = useCallback(
    (mode: typeof interactionMode) => {
      setComposerDraftInteractionMode(threadRef, mode);
      focusComposer();
    },
    [focusComposer, setComposerDraftInteractionMode, threadRef],
  );

  const toggleInteractionMode = useCallback(() => {
    handleInteractionModeChange(interactionMode === "plan" ? "default" : "plan");
  }, [handleInteractionModeChange, interactionMode]);

  const getModelDisabledReason = useCallback(
    (instanceId: ProviderInstanceId, model: string): string | null => {
      if (!thread) return null;
      const reason = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession: thread.session !== null,
        currentModelSelection: thread.modelSelection,
        currentProviderInstanceId: thread.session?.providerInstanceId ?? null,
        nextModelSelection: { instanceId, model },
      });
      return reason ? `${reason.description} Start a new thread to use this model.` : null;
    },
    [providerStatuses, thread],
  );

  const onProviderModelSelect = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      if (!thread) return;
      const resolvedModel = resolveAppModelSelectionForInstance(
        instanceId,
        settings,
        providerStatuses,
        model,
      );
      if (!resolvedModel) {
        focusComposer();
        return;
      }
      const nextModelSelection = { instanceId, model: resolvedModel };
      const modelChangeBlockReason = getStartedThreadModelChangeBlockReason({
        providers: providerStatuses,
        hasStartedSession: thread.session !== null,
        currentModelSelection: thread.modelSelection,
        currentProviderInstanceId: thread.session?.providerInstanceId ?? null,
        nextModelSelection,
      });
      if (modelChangeBlockReason) {
        setError(`${modelChangeBlockReason.title}: ${modelChangeBlockReason.description}`);
        focusComposer();
        return;
      }
      setError(null);
      setComposerDraftModelSelection(threadRef, nextModelSelection);
      setStickyComposerModelSelection(nextModelSelection);
      focusComposer();
    },
    [
      focusComposer,
      providerStatuses,
      setComposerDraftModelSelection,
      setStickyComposerModelSelection,
      settings,
      thread,
      threadRef,
    ],
  );

  const send = useCallback(async () => {
    if (!thread || busy) return;
    const sendContext = composerRef.current?.getSendContext();
    if (!sendContext) return;
    // Monitor has never submitted review comments; retain that behavior while
    // sharing the same prompt/context and command transaction as ChatView.
    const submissionDraft = threadTurnDraftFromComposer(sendContext, { reviewComments: [] });
    const analysis = analyzeThreadTurnDraft(submissionDraft);
    if (!analysis.hasSendableContent) return;
    const api = readEnvironmentApi(threadRef.environmentId);
    if (!api) return;
    setBusy(true);
    setError(null);
    await submitThreadTurn({
      draft: submissionDraft,
      analysis,
      target: {
        environmentId: threadRef.environmentId,
        threadId: threadRef.threadId,
        threadCreatedAt: thread.createdAt,
        threadWorktreePath: thread.worktreePath,
        projectId: thread.projectId,
        projectWorkspaceRoot: activeProject?.workspaceRoot ?? "",
        projectDefaultModelSelection: activeProject?.defaultModelSelection,
        isServerThread: true,
        isLocalDraftThread: false,
        isFirstMessage: false,
        queue: isRunning,
        prepareWorkspace: false,
        activeBranch: thread.branch,
        baseRevision: null,
        startFromOrigin: false,
        runtimeMode,
        interactionMode,
      },
      title: resolveFollowUpSubmissionTitle(analysis, thread.title),
      delivery: createDirectThreadTurnDeliveryAdapter({
        dispatchCommand: (command) => api.orchestration.dispatchCommand(command),
      }),
      composer: {
        clearOnSuccess: "always",
        readCurrentRevision: () => {
          const currentDraft = useComposerDraftStore.getState().getComposerDraft(threadRef);
          return threadComposerRevision({
            prompt: promptRef.current,
            images: composerImagesRef.current,
            terminalContexts: composerTerminalContextsRef.current,
            elementContexts: composerElementContextsRef.current,
            previewAnnotations: currentDraft?.previewAnnotations ?? [],
            reviewComments: [],
          });
        },
        clear: () => {
          promptRef.current = "";
          clearComposerDraftContent(threadRef);
          composerRef.current?.resetCursorState();
        },
      },
      lifecycle: {
        delivered: () => setComposerExpanded(false),
        failed: (error) =>
          setError(error instanceof Error ? error.message : "Failed to send follow-up."),
        settled: () => setBusy(false),
      },
      makeCommandId: newCommandId,
      makeMessageId: newMessageId,
      now: () => new Date().toISOString(),
    });
  }, [
    activeProject?.defaultModelSelection,
    activeProject?.workspaceRoot,
    busy,
    clearComposerDraftContent,
    interactionMode,
    isRunning,
    runtimeMode,
    thread,
    threadRef,
  ]);

  const interrupt = useCallback(async () => {
    const api = readEnvironmentApi(threadRef.environmentId);
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.turn.interrupt",
        commandId: newCommandId(),
        threadId: threadRef.threadId,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to interrupt thread.");
    } finally {
      setBusy(false);
    }
  }, [threadRef.environmentId, threadRef.threadId]);

  const { dispatchQueuedMessage, deleteQueuedMessage } = useThreadQueuedMessageControls({
    threadRef,
    clearErrorBeforeAction: true,
    onError: setError,
  });

  return (
    <div className="shrink-0 border-t border-border/60 bg-background/80 p-2">
      <MonitorPendingActions
        threadRef={threadRef}
        fallbackThread={fallbackThread}
        pendingApprovals={pendingApprovals}
        pendingUserInputs={pendingUserInputs}
        disabled={busy}
        onError={setError}
      />
      {error ? (
        <div className="mt-2 rounded-md border border-red-400/25 bg-red-500/8 px-2 py-1 text-[11px] text-red-700 dark:text-red-200">
          {error}
        </div>
      ) : null}
      {thread ? (
        <div
          className="relative isolate mt-2"
          data-monitor-composer={showComposer ? "full" : "collapsed"}
        >
          <div className="relative z-0" onClickCapture={handleQueuedStripClick}>
            <QueuedMessagesStrip
              queuedMessages={thread.queuedMessages ?? []}
              isRunning={isRunning}
              density="compact"
              onDispatch={(message) => void dispatchQueuedMessage(message)}
              onDelete={(message) => void deleteQueuedMessage(message)}
            />
          </div>
          {showComposer ? (
            <div
              ref={composerShellRef}
              className="relative z-10"
              onBlurCapture={handleExpandedComposerBlur}
              onKeyDown={handleExpandedComposerKeyDown}
            >
              <ChatComposer
                composerRef={composerRef}
                composerDraftTarget={threadRef}
                environmentId={threadRef.environmentId}
                routeKind="server"
                routeThreadRef={threadRef}
                draftId={null}
                activeThreadId={thread.id}
                activeThreadEnvironmentId={thread.environmentId}
                activeThread={thread}
                isServerThread
                isLocalDraftThread={false}
                forceExpandedOnMobile
                projectSelectionRequired={false}
                phase={phase}
                isConnecting={false}
                isSendBusy={busy}
                isPreparingWorktree={false}
                environmentUnavailable={null}
                activePendingApproval={null}
                pendingApprovals={[]}
                pendingUserInputs={[]}
                activePendingProgress={null}
                activePendingResolvedAnswers={null}
                activePendingIsResponding={false}
                activePendingDraftAnswers={EMPTY_PENDING_DRAFT_ANSWERS}
                activePendingQuestionIndex={0}
                respondingRequestIds={EMPTY_RESPONDING_REQUEST_IDS}
                showPlanFollowUpPrompt={false}
                activeProposedPlan={null}
                runtimeMode={runtimeMode}
                interactionMode={interactionMode}
                lockedProvider={null}
                providerStatuses={providerStatuses}
                activeProjectDefaultModelSelection={activeProject?.defaultModelSelection}
                activeThreadModelSelection={thread.modelSelection}
                activeThreadActivities={thread.activities}
                usageLimitsSources={usageLimitsSources}
                resolvedTheme={resolvedTheme}
                settings={settings}
                keybindings={keybindings}
                terminalOpen={false}
                gitCwd={activeProject?.workspaceRoot ?? null}
                promptRef={promptRef}
                composerImagesRef={composerImagesRef}
                composerTerminalContextsRef={composerTerminalContextsRef}
                composerElementContextsRef={composerElementContextsRef}
                onSend={send}
                onInterrupt={interrupt}
                onImplementPlanInNewThread={() => undefined}
                onRespondToApproval={async () => undefined}
                onSelectActivePendingUserInputOption={() => undefined}
                onAdvanceActivePendingUserInput={() => undefined}
                onSkipActivePendingUserInput={() => undefined}
                onPreviousActivePendingUserInputQuestion={() => undefined}
                onChangeActivePendingUserInputCustomAnswer={() => undefined}
                onProviderModelSelect={onProviderModelSelect}
                getModelDisabledReason={getModelDisabledReason}
                toggleInteractionMode={toggleInteractionMode}
                handleRuntimeModeChange={handleRuntimeModeChange}
                handleInteractionModeChange={handleInteractionModeChange}
                focusComposer={focusComposer}
                scheduleComposerFocus={focusComposer}
                setThreadError={(_threadId, message) => setError(message)}
                onExpandImage={setExpandedImage}
                variant="inline"
              />
            </div>
          ) : (
            <button
              ref={collapsedComposerButtonRef}
              type="button"
              className="relative z-10 flex min-h-10 w-full items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-left text-sm shadow-xs/5 outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              data-monitor-composer-trigger="true"
              onClick={() => expandComposer()}
            >
              <MessageSquareTextIcon className="size-4 text-muted-foreground" />
              <span className="shrink-0 font-medium text-foreground">Follow up</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">Ask anything</span>
              <ArrowRightIcon className="size-3.5 text-muted-foreground" />
            </button>
          )}
        </div>
      ) : (
        <div className="mt-2 rounded-xl border border-border/70 bg-card/70 px-3 py-3 text-xs text-muted-foreground">
          Loading composer...
        </div>
      )}
      {expandedImage ? (
        <ExpandedImageDialog preview={expandedImage} onClose={() => setExpandedImage(null)} />
      ) : null}
    </div>
  );
}

function MonitorPendingActions({
  threadRef,
  fallbackThread,
  pendingApprovals,
  pendingUserInputs,
  disabled,
  onError,
}: {
  threadRef: ScopedThreadRef;
  fallbackThread: SidebarThreadSummary;
  pendingApprovals: readonly PendingApproval[];
  pendingUserInputs: readonly PendingUserInput[];
  disabled: boolean;
  onError: (message: string | null) => void;
}) {
  const approval = pendingApprovals[0] ?? null;
  const userInput = pendingUserInputs[0] ?? null;
  const planReady = hasPlanReadyPrompt(fallbackThread);
  const [draftAnswers, setDraftAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [respondingRequestId, setRespondingRequestId] = useState<ApprovalRequestId | null>(null);
  const responseDisabled = disabled || respondingRequestId !== null;

  const respondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      const api = readEnvironmentApi(threadRef.environmentId);
      if (!api) return;
      setRespondingRequestId(requestId);
      onError(null);
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.approval.respond",
          commandId: newCommandId(),
          threadId: threadRef.threadId,
          requestId,
          decision,
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        onError(err instanceof Error ? err.message : "Failed to submit approval decision.");
      } finally {
        setRespondingRequestId(null);
      }
    },
    [onError, threadRef.environmentId, threadRef.threadId],
  );

  const respondToUserInput = useCallback(
    async (requestId: ApprovalRequestId, answers: Record<string, string | string[]>) => {
      const api = readEnvironmentApi(threadRef.environmentId);
      if (!api) return;
      setRespondingRequestId(requestId);
      onError(null);
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.user-input.respond",
          commandId: newCommandId(),
          threadId: threadRef.threadId,
          requestId,
          answers,
          createdAt: new Date().toISOString(),
        });
        setDraftAnswers({});
      } catch (err) {
        onError(err instanceof Error ? err.message : "Failed to submit user input.");
      } finally {
        setRespondingRequestId(null);
      }
    },
    [onError, threadRef.environmentId, threadRef.threadId],
  );

  if (!approval && !userInput && !planReady) return null;

  return (
    <div className="space-y-1.5 rounded-md border border-amber-400/25 bg-amber-500/8 p-2">
      {approval ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-amber-800 dark:text-amber-100">
            <ShieldCheckIcon className="size-3.5" />
            {approval.requestKind} approval
          </div>
          {approval.detail ? (
            <p className="line-clamp-2 text-[11px] text-muted-foreground">{approval.detail}</p>
          ) : null}
          <div className="flex gap-1">
            <Button
              type="button"
              size="xs"
              disabled={responseDisabled}
              onClick={() => void respondToApproval(approval.requestId, "accept")}
            >
              <CheckIcon className="size-3" />
              Allow
            </Button>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={responseDisabled}
              onClick={() => void respondToApproval(approval.requestId, "acceptForSession")}
            >
              <PinIcon className="size-3" />
              Session
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={responseDisabled}
              onClick={() => void respondToApproval(approval.requestId, "decline")}
            >
              <XIcon className="size-3" />
              Decline
            </Button>
          </div>
        </div>
      ) : null}
      {userInput ? (
        <MonitorUserInputPrompt
          prompt={userInput}
          draftAnswers={draftAnswers}
          setDraftAnswers={setDraftAnswers}
          onRespond={respondToUserInput}
          disabled={responseDisabled}
          threadRef={threadRef}
        />
      ) : null}
      {!approval && !userInput && planReady ? (
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[11px] font-medium text-amber-800 dark:text-amber-100">
              Plan ready
            </div>
            <p className="truncate text-[10px] text-muted-foreground/70">
              Open the full thread to inspect or implement it.
            </p>
          </div>
          <Button
            render={
              <Link
                to="/$environmentId/$threadId"
                params={{
                  environmentId: threadRef.environmentId,
                  threadId: threadRef.threadId,
                }}
              />
            }
            size="xs"
            variant="outline"
          >
            Open
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function MonitorUserInputPrompt({
  prompt,
  draftAnswers,
  setDraftAnswers,
  onRespond,
  disabled,
  threadRef,
}: {
  prompt: PendingUserInput;
  draftAnswers: Record<string, PendingUserInputDraftAnswer>;
  setDraftAnswers: (
    updater: (
      answers: Record<string, PendingUserInputDraftAnswer>,
    ) => Record<string, PendingUserInputDraftAnswer>,
  ) => void;
  onRespond: (
    requestId: ApprovalRequestId,
    answers: Record<string, string | string[]>,
  ) => Promise<void>;
  disabled: boolean;
  threadRef: ScopedThreadRef;
}) {
  const question = prompt.questions[0] ?? null;
  if (!question) return null;
  const completeAnswers = buildPendingUserInputAnswers(prompt.questions, draftAnswers);
  const isMultiQuestion = prompt.questions.length > 1;
  const hasHiddenOptions = question.options.length > 4;
  const requiresFullThread = isMultiQuestion || hasHiddenOptions;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-amber-800 dark:text-amber-100">
        <MessageSquareTextIcon className="size-3.5" />
        {question.header}
        {prompt.optional ? (
          <span className="text-[10px] text-muted-foreground">Optional</span>
        ) : null}
        {isMultiQuestion ? (
          <span className="text-[10px] text-muted-foreground">1/{prompt.questions.length}</span>
        ) : null}
      </div>
      <p className="text-[11px] text-foreground/85">{question.question}</p>
      {!requiresFullThread ? (
        <div className="grid gap-1">
          {question.options.map((option) => {
            const selected = draftAnswers[question.id]?.selectedOptionLabels?.includes(
              option.label,
            );
            return (
              <button
                key={option.label}
                type="button"
                disabled={disabled}
                className={cn(
                  "rounded-md border px-2 py-1 text-left text-[11px] transition-colors",
                  selected
                    ? "border-primary/35 bg-primary/10 text-foreground"
                    : "border-border/55 bg-background/50 text-muted-foreground hover:text-foreground",
                )}
                onClick={() => {
                  setDraftAnswers((answers) => ({
                    ...answers,
                    [question.id]: togglePendingUserInputOptionSelection(
                      question,
                      answers[question.id],
                      option.label,
                    ),
                  }));
                }}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-muted-foreground/65">
          {requiresFullThread
            ? "This prompt needs the full thread form."
            : "Select an option, then submit."}
        </span>
        <div className="flex items-center gap-1">
          {prompt.optional ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={disabled}
              onClick={() => void onRespond(prompt.requestId, {})}
            >
              Skip
            </Button>
          ) : null}
          {requiresFullThread ? (
            <Button
              render={
                <Link
                  to="/$environmentId/$threadId"
                  params={{
                    environmentId: threadRef.environmentId,
                    threadId: threadRef.threadId,
                  }}
                />
              }
              size="xs"
              variant="outline"
            >
              Open
            </Button>
          ) : (
            <Button
              type="button"
              size="xs"
              disabled={disabled || !completeAnswers}
              onClick={() => {
                if (completeAnswers) void onRespond(prompt.requestId, completeAnswers);
              }}
            >
              Submit
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
