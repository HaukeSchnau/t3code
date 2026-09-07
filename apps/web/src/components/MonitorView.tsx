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
import { Link } from "@tanstack/react-router";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  RuntimeRequestId,
  ScopedThreadRef,
  ServerProvider,
} from "@t3tools/contracts";
import type { PendingUserInputDraftAnswer } from "../pendingUserInput";
import {
  type CSSProperties,
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
  deriveTimelineEntriesFromVisibleTurnItems,
  isLatestRunSettled,
  type PendingApproval,
  type PendingUserInput,
} from "../session-logic";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import { cn, newCommandId, newMessageId } from "../lib/utils";
import { buildPendingUserInputAnswers, togglePendingUserInputOptionSelection } from "../pendingUserInput";
import { useProjects, useThreadProjection } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { type ChatMessage } from "../types";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { useSidebarCardThreads } from "./sidebar/SidebarCardThreadsContext";

type SidebarThreadSummary = EnvironmentThreadShell;
type Thread = EnvironmentThread;
type MonitorRuntimeStatus = NonNullable<EnvironmentThreadShell["runtime"]>["status"];

/** The monitor derives the same ordered rows as the full V2 thread view. */
export function deriveMonitorTimelineEntries(thread: Thread): ReturnType<typeof deriveTimelineEntriesFromVisibleTurnItems> {
  const projection = thread.projection;
  return deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: projection.visibleTurnItems,
    attempts: projection.attempts,
    nodes: projection.nodes,
    plans: projection.plans,
    optimisticMessages: [],
  });
}

const MONITOR_ORDER_STORAGE_KEY = "t3code.monitor.threadOrder.v2";
const EMPTY_TURN_DIFFS = new Map();
const EMPTY_REVERT_COUNTS = new Map();
const EMPTY_PROVIDER_SKILLS: [] = [];
const EMPTY_PROVIDER_STATUSES: ReadonlyArray<ServerProvider> = [];
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

type MonitorGridStyle = CSSProperties & { "--monitor-grid-columns": number };

function toTimestamp(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

function isLiveSessionStatus(status: MonitorRuntimeStatus | undefined): boolean {
  if (status === undefined) return false;
  return status === "starting" || status === "running";
}

function hasPlanReadyPrompt(thread: SidebarThreadSummary): boolean {
  return (
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestRunSettled(thread.latestRun, thread.runtime) &&
    thread.hasActionableProposedPlan
  );
}

export function resolveMonitorThreadCandidate(thread: SidebarThreadSummary): MonitorThreadCandidate {
  const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const actionable = thread.hasPendingApprovals || thread.hasPendingUserInput;
  const planReady = hasPlanReadyPrompt(thread);
  const status = thread.runtime?.status ?? thread.latestRun?.status;
  const hasError = status === "failed" || status === "interrupted";
  const running = isLiveSessionStatus(thread.runtime?.status);
  const reason: MonitorThreadReason = actionable
    ? "actionable"
    : hasError
      ? "error"
      : running
        ? "running"
        : planReady
          ? "plan"
          : "ready";
  const priority = reason === "actionable" ? 0 : reason === "error" ? 1 : reason === "running" ? 2 : reason === "plan" ? 3 : 4;
  const timestamp = Math.max(
    toTimestamp(thread.latestUserMessageAt),
    toTimestamp(thread.latestRun?.startedAt),
    toTimestamp(thread.latestRun?.completedAt),
    toTimestamp(thread.updatedAt),
    toTimestamp(thread.createdAt),
  );
  return { thread, key, reason, priority, timestamp };
}

function sortCandidatesForInitialPlacement(candidates: readonly MonitorThreadCandidate[]) {
  return [...candidates].sort((left, right) =>
    left.priority !== right.priority
      ? left.priority - right.priority
      : left.timestamp !== right.timestamp
        ? right.timestamp - left.timestamp
        : left.key.localeCompare(right.key),
  );
}

function readStoredOrder(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(MONITOR_ORDER_STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

function writeStoredOrder(order: readonly string[]) {
  if (typeof window !== "undefined") window.localStorage.setItem(MONITOR_ORDER_STORAGE_KEY, JSON.stringify(order));
}

function useStableMonitorCandidates(threads: readonly SidebarThreadSummary[]) {
  const [order, setOrder] = useState<string[]>(readStoredOrder);
  const candidates = useMemo(() => threads.map(resolveMonitorThreadCandidate), [threads]);
  useEffect(() => {
    setOrder((previous) => {
      const available = new Set(candidates.map((candidate) => candidate.key));
      const retained = previous.filter((key) => available.has(key));
      const retainedSet = new Set(retained);
      const added = sortCandidatesForInitialPlacement(candidates)
        .map((candidate) => candidate.key)
        .filter((key) => !retainedSet.has(key));
      const next = [...retained, ...added];
      if (next.length === previous.length && next.every((key, index) => key === previous[index])) return previous;
      writeStoredOrder(next);
      return next;
    });
  }, [candidates]);
  return useMemo(() => {
    const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
    return (order.length === 0 ? sortCandidatesForInitialPlacement(candidates) : order.flatMap((key) => {
      const candidate = byKey.get(key);
      return candidate ? [candidate] : [];
    }));
  }, [candidates, order]);
}

function useMonitorGridColumns(count: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [columns, setColumns] = useState(1);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      const maxColumns = Math.max(1, Math.min(count, Math.floor((width + MONITOR_GRID_GAP_PX) / (MONITOR_TILE_TARGET_MIN_WIDTH_PX + MONITOR_GRID_GAP_PX))));
      let best = 1;
      let score = Number.POSITIVE_INFINITY;
      for (let columns = 1; columns <= maxColumns; columns += 1) {
        const rows = Math.ceil(count / columns);
        const empty = columns * rows - count;
        const tileWidth = (width - MONITOR_GRID_GAP_PX * (columns - 1)) / columns;
        const tileHeight = (height - MONITOR_GRID_GAP_PX * (rows - 1)) / rows;
        const aspect = tileWidth / Math.max(1, tileHeight);
        const nextScore = Math.abs(Math.log(aspect / MONITOR_TILE_TARGET_ASPECT_RATIO)) + empty * 1.4 + (columns === 1 && count > 1 ? 0.5 : 0);
        if (nextScore < score) { score = nextScore; best = columns; }
      }
      setColumns((current) => (current === best ? current : best));
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [count]);
  return [ref, columns] as const;
}

function useTileVisibility() {
  const ref = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)), { rootMargin: "280px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, visible] as const;
}

function formatElapsed(startedAt: string | null | undefined): string | null {
  if (!startedAt) return null;
  const elapsed = Date.now() - Date.parse(startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const minutes = Math.floor(elapsed / 60_000);
  return minutes < 1 ? "now" : minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function reasonLabel(reason: MonitorThreadReason) {
  return reason === "actionable" ? "Needs input" : reason === "error" ? "Blocked" : reason === "running" ? "Running" : reason === "plan" ? "Plan ready" : "Ready";
}

function reasonClassName(reason: MonitorThreadReason) {
  return reason === "actionable"
    ? "border-amber-400/40 bg-amber-500/10 text-amber-700 dark:text-amber-200"
    : reason === "error"
      ? "border-red-400/40 bg-red-500/10 text-red-700 dark:text-red-200"
      : reason === "running"
        ? "border-sky-400/40 bg-sky-500/10 text-sky-700 dark:text-sky-200"
        : reason === "plan"
          ? "border-violet-400/40 bg-violet-500/10 text-violet-700 dark:text-violet-200"
          : "border-border bg-muted/40 text-muted-foreground";
}

export function MonitorView() {
  const candidates = useStableMonitorCandidates(useSidebarCardThreads() ?? []);
  const [gridViewportRef, gridColumns] = useMonitorGridColumns(candidates.length);
  const gridStyle = useMemo<MonitorGridStyle>(() => ({ "--monitor-grid-columns": gridColumns }), [gridColumns]);
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <div className="flex min-h-0 flex-1 flex-col">
        {candidates.length === 0 ? (
          <Empty className="flex-1"><EmptyHeader><EmptyTitle>No active threads</EmptyTitle><EmptyDescription>Non-settled, non-snoozed threads will appear here.</EmptyDescription></EmptyHeader></Empty>
        ) : (
          <div ref={gridViewportRef} className="monitor-grid min-h-0 flex-1 overflow-auto p-2 sm:p-3">
            <div className="grid h-full min-h-full auto-rows-[minmax(22rem,1fr)] grid-cols-[repeat(var(--monitor-grid-columns),minmax(0,1fr))] gap-1.5 sm:gap-2" style={gridStyle}>
              {candidates.map((candidate) => <MonitorThreadTile key={candidate.key} candidate={candidate} />)}
            </div>
          </div>
        )}
      </div>
    </SidebarInset>
  );
}

const MonitorThreadTile = memo(function MonitorThreadTile({ candidate }: { candidate: MonitorThreadCandidate }) {
  const threadRef = useMemo(() => scopeThreadRef(candidate.thread.environmentId, candidate.thread.id), [candidate.thread.environmentId, candidate.thread.id]);
  const [tileRef, visible] = useTileVisibility();
  const projection = useThreadProjection(visible ? threadRef : null);
  const projects = useProjects();
  const project = projects.find((item) => item.environmentId === candidate.thread.environmentId && item.id === candidate.thread.projectId);
  const activeRun = candidate.thread.latestRun;
  const running = isLiveSessionStatus(candidate.thread.runtime?.status);
  const startedAt = running ? deriveActiveWorkStartedAt(activeRun, candidate.thread.runtime, null) : null;
  return (
    <section ref={tileRef} className={cn("group/tile flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card/48 shadow-sm/5", candidate.reason === "actionable" ? "border-amber-400/35" : candidate.reason === "error" ? "border-red-400/35" : "border-border/70")} data-testid="monitor-thread-tile">
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border/60 px-2.5 py-2">
        <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium", reasonClassName(candidate.reason))}>
          {running ? <LoaderCircleIcon className="size-3 animate-spin" /> : null}{reasonLabel(candidate.reason)}
        </span>
        <div className="min-w-0 flex-1"><div className="truncate text-xs font-medium text-foreground/92">{candidate.thread.title}</div><div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground/60"><span className="truncate">{project?.title ?? "Unknown project"}</span>{formatElapsed(startedAt) ? <><span>/</span><span className="inline-flex items-center gap-1 tabular-nums"><Clock3Icon className="size-3" />{formatElapsed(startedAt)}</span></> : null}</div></div>
        <Button render={<Link to="/$environmentId/$threadId" params={{ environmentId: candidate.thread.environmentId, threadId: candidate.thread.id }} />} size="icon-xs" variant="ghost" aria-label="Open full thread"><ArrowRightIcon className="size-3.5" /></Button>
      </div>
      <MonitorThreadBody shell={candidate.thread} projection={projection} visible={visible} threadRef={threadRef} {...(project?.workspaceRoot === undefined ? {} : { projectCwd: project.workspaceRoot })} />
      <MonitorThreadActions shell={candidate.thread} projection={projection} threadRef={threadRef} />
    </section>
  );
});

function MonitorThreadBody({ shell, projection, visible, threadRef, projectCwd }: { shell: SidebarThreadSummary; projection: Thread | null; visible: boolean; threadRef: ScopedThreadRef; projectCwd?: string }) {
  const listRef = useRef<LegendListRef | null>(null);
  const { resolvedTheme } = useTheme();
  const settings = useEnvironmentSettings(threadRef.environmentId);
  if (!visible) return <div className="flex min-h-0 flex-1 flex-col justify-between p-2.5 text-xs text-muted-foreground/70"><div><p className="font-medium text-foreground/75">{shell.title}</p><p className="mt-1">Thread detail will hydrate when this tile scrolls into view.</p></div><div className="rounded-md border border-border/60 bg-muted/25 px-2 py-1 text-[11px]">{shell.runtime?.status ?? "idle"}</div></div>;
  if (projection === null) return <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground/65">Loading thread...</div>;
  const latestRun = shell.latestRun;
  const running = isLiveSessionStatus(shell.runtime?.status);
  const timelineEntries = deriveMonitorTimelineEntries(projection);
  const markdownCwd = shell.worktreePath ?? projectCwd;
  return <div className="monitor-tile-transcript relative min-h-0 flex-1 text-[12px]"><MessagesTimeline isWorking={running} activeTurnInProgress={running && !isLatestRunSettled(latestRun, shell.runtime)} activeTurnStartedAt={deriveActiveWorkStartedAt(latestRun, shell.runtime, null)} listRef={listRef} timelineEntries={timelineEntries} latestRun={latestRun} runningRunId={shell.runtime?.activeRunId ?? null} turnDiffSummaryByAssistantMessageId={EMPTY_TURN_DIFFS} routeThreadKey={scopedThreadKey(threadRef)} onOpenTurnDiff={() => undefined} onOpenThread={() => undefined} onForkFromRun={async () => undefined} onRollbackCheckpoint={() => undefined} revertTurnCountByUserMessageId={EMPTY_REVERT_COUNTS} onRevertUserMessage={() => undefined} isRevertingCheckpoint={false} onImageExpand={() => undefined} activeThreadEnvironmentId={threadRef.environmentId} markdownCwd={markdownCwd} resolvedTheme={resolvedTheme} timestampFormat={settings.timestampFormat} workspaceRoot={projectCwd} skills={EMPTY_PROVIDER_SKILLS} providerStatuses={EMPTY_PROVIDER_STATUSES} runs={projection.projection.runs} anchorMessageId={null} onAnchorReady={() => undefined} onAnchorSizeChanged={() => undefined} contentInsetEndAdjustment={0} onIsAtEndChange={() => undefined} liveFollowEnabled={false} onManualNavigation={() => undefined} /> </div>;
}

function MonitorThreadActions({ shell, projection, threadRef }: { shell: SidebarThreadSummary; projection: Thread | null; threadRef: ScopedThreadRef }) {
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const respondToApproval = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const respondToUserInput = useAtomCommand(threadEnvironment.respondToUserInput, { reportFailure: false });
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const projectionRequests = projection ? derivePendingThreadRequests(projection.projection) : { approvals: [], userInputs: [] };
  const approval: PendingApproval | undefined = projectionRequests.approvals[0];
  const userInput: PendingUserInput | undefined = projectionRequests.userInputs[0];
  const running = isLiveSessionStatus(shell.runtime?.status);
  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true); setError(null);
    const result = await startTurn({ environmentId: threadRef.environmentId, input: { threadId: threadRef.threadId, message: { messageId: newMessageId(), role: "user", text, attachments: [] }, runtimeMode: shell.runtimeMode, interactionMode: shell.interactionMode, dispatchMode: running ? "queue" : "start", createdAt: new Date().toISOString() } });
    if (result._tag === "Failure") setError("Failed to send follow-up."); else setDraft("");
    setBusy(false);
  }, [busy, draft, interactionModeForDeps(shell), running, shell.interactionMode, shell.runtimeMode, startTurn, threadRef]);
  const interrupt = useCallback(async () => { if (!shell.runtime?.activeRunId) return; setBusy(true); setError(null); const result = await interruptTurn({ environmentId: threadRef.environmentId, input: { threadId: threadRef.threadId, runId: shell.runtime.activeRunId } }); if (result._tag === "Failure") setError("Failed to interrupt thread."); setBusy(false); }, [interruptTurn, shell.runtime?.activeRunId, threadRef]);
  const respondApproval = useCallback(async (requestId: RuntimeRequestId, decision: ProviderApprovalDecision) => { setBusy(true); setError(null); const result = await respondToApproval({ environmentId: threadRef.environmentId, input: { threadId: threadRef.threadId, requestId, decision } }); if (result._tag === "Failure") setError("Failed to submit approval decision."); setBusy(false); }, [respondToApproval, threadRef]);
  const respondInput = useCallback(async (requestId: RuntimeRequestId, values: Record<string, string | string[]>) => { setBusy(true); setError(null); const result = await respondToUserInput({ environmentId: threadRef.environmentId, input: { threadId: threadRef.threadId, requestId, answers: values } }); if (result._tag === "Failure") setError("Failed to submit response."); else setAnswers({}); setBusy(false); }, [respondToUserInput, threadRef]);
  const question = userInput?.questions[0];
  const completeAnswers = question ? buildPendingUserInputAnswers(userInput.questions, answers) : null;
  return <div className="shrink-0 border-t border-border/60 bg-background/80 p-2">
    {approval || question || hasPlanReadyPrompt(shell) ? <div className="space-y-2 rounded-md border border-amber-400/25 bg-amber-500/8 p-2 text-[11px]">
      {approval ? <div className="space-y-1.5"><div className="flex items-center gap-1.5 font-medium text-amber-800 dark:text-amber-100"><ShieldCheckIcon className="size-3.5" />{approval.requestKind} approval</div><div className="flex gap-1"><Button size="xs" disabled={busy} onClick={() => void respondApproval(approval.requestId, "accept") }><CheckIcon className="size-3" />Allow</Button><Button size="xs" variant="outline" disabled={busy} onClick={() => void respondApproval(approval.requestId, "acceptForSession")}><PinIcon className="size-3" />Session</Button><Button size="xs" variant="ghost" disabled={busy} onClick={() => void respondApproval(approval.requestId, "decline")}><XIcon className="size-3" />Decline</Button></div></div> : null}
      {question ? <div className="space-y-1.5"><div className="flex items-center gap-1.5 font-medium text-amber-800 dark:text-amber-100"><MessageSquareTextIcon className="size-3.5" />{question.header}</div><p className="text-foreground/85">{question.question}</p><div className="grid gap-1">{question.options.map((option) => { const value = option.value ?? option.label; const selected = answers[question.id]?.selectedOptionValues?.includes(value) ?? false; return <button key={option.label} type="button" disabled={busy} className={cn("rounded-md border px-2 py-1 text-left transition-colors", selected ? "border-primary/35 bg-primary/10 text-foreground" : "border-border/55 bg-background/50 text-muted-foreground hover:text-foreground")} onClick={() => setAnswers((current) => ({ ...current, [question.id]: togglePendingUserInputOptionSelection(question, current[question.id], value) }))}>{option.label}</button>; })}</div><Button size="xs" disabled={busy || completeAnswers === null} onClick={() => completeAnswers && void respondInput(userInput.requestId, completeAnswers)}>Submit</Button></div> : null}
      {hasPlanReadyPrompt(shell) ? <div className="flex items-center justify-between"><span className="font-medium text-amber-800 dark:text-amber-100">Plan ready</span><Button render={<Link to="/$environmentId/$threadId" params={{ environmentId: threadRef.environmentId, threadId: threadRef.threadId }} />} size="xs" variant="outline">Open</Button></div> : null}
    </div> : null}
    {error ? <div className="mt-2 rounded-md border border-red-400/25 bg-red-500/8 px-2 py-1 text-[11px] text-red-700 dark:text-red-200">{error}</div> : null}
    <form className="mt-2 flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); void send(); }}><MessageSquareTextIcon className="size-4 text-muted-foreground" /><input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={running ? "Queue a follow-up" : "Ask anything"} disabled={busy} className="min-w-0 flex-1 rounded-md border border-border bg-card px-2.5 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />{running ? <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => void interrupt()}>Stop</Button> : null}<Button type="submit" size="xs" disabled={busy || draft.trim().length === 0}>Send</Button></form>
  </div>;
}

function interactionModeForDeps(shell: SidebarThreadSummary): string { return shell.interactionMode; }
