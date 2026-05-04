import { type EnvironmentId, type MessageId, type TurnId } from "@t3tools/contracts";
import { FileDiff } from "@pierre/diffs/react";
import {
  createContext,
  memo,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { deriveTimelineEntries, formatElapsed } from "../../session-logic";
import { type TurnDiffSummary } from "../../types";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CheckIcon,
  CircleAlertIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  type LucideIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  computeStableMessagesTimelineRows,
  MAX_VISIBLE_WORK_LOG_ENTRIES,
  deriveMessagesTimelineRows,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  type StableMessagesTimelineRowsState,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import { useUiStateStore } from "~/uiStateStore";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { formatTimestamp } from "../../timestampFormat";

import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import {
  hasToolContextDetails,
  type ToolContextField,
  type ToolContextPresentation,
} from "../../lib/codexToolContext";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { getRenderablePatch, resolveFileDiffPath } from "../../lib/renderablePatch";
import {
  captureTerminalViewportSnapshot,
  renderTerminalOutput,
  resolveTerminalViewportScrollTop,
} from "../../lib/terminalOutput";

// ---------------------------------------------------------------------------
// Context — shared state consumed by every row component via useContext.
// Propagates through LegendList's memo boundaries for shared callbacks and
// non-row-scoped state. `nowIso` is intentionally excluded — self-ticking
// components (WorkingTimer, LiveElapsed) handle it.
// ---------------------------------------------------------------------------

interface TimelineRowSharedState {
  activeTurnInProgress: boolean;
  activeTurnId: TurnId | null | undefined;
  isWorking: boolean;
  isRevertingCheckpoint: boolean;
  completionSummary: string | null;
  timestampFormat: TimestampFormat;
  routeThreadKey: string;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  workspaceRoot: string | undefined;
  activeThreadEnvironmentId: EnvironmentId;
  hideCheckpointChangedFiles: boolean;
  onRevertUserMessage: (messageId: MessageId) => void;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}

const TimelineRowCtx = createContext<TimelineRowSharedState>(null!);

// ---------------------------------------------------------------------------
// Props (public API)
// ---------------------------------------------------------------------------

interface MessagesTimelineProps {
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnId?: TurnId | null;
  activeTurnStartedAt: string | null;
  listRef: React.RefObject<LegendListRef | null>;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  routeThreadKey: string;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  activeThreadEnvironmentId: EnvironmentId;
  hideCheckpointChangedFiles?: boolean;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  onIsAtEndChange: (isAtEnd: boolean) => void;
}

// ---------------------------------------------------------------------------
// MessagesTimeline — list owner
// ---------------------------------------------------------------------------

export const MessagesTimeline = memo(function MessagesTimeline({
  isWorking,
  activeTurnInProgress,
  activeTurnId,
  activeTurnStartedAt,
  listRef,
  timelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  routeThreadKey,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
  activeThreadEnvironmentId,
  hideCheckpointChangedFiles = false,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  onIsAtEndChange,
}: MessagesTimelineProps) {
  const rawRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        completionDividerBeforeEntryId,
        isWorking,
        activeTurnStartedAt,
        turnDiffSummaryByAssistantMessageId,
        revertTurnCountByUserMessageId,
      }),
    [
      timelineEntries,
      completionDividerBeforeEntryId,
      isWorking,
      activeTurnStartedAt,
      turnDiffSummaryByAssistantMessageId,
      revertTurnCountByUserMessageId,
    ],
  );
  const rows = useStableRows(rawRows);

  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState?.();
    if (state) {
      onIsAtEndChange(state.isAtEnd);
    }
  }, [listRef, onIsAtEndChange]);

  const previousRowCountRef = useRef(rows.length);
  useEffect(() => {
    const previousRowCount = previousRowCountRef.current;
    previousRowCountRef.current = rows.length;

    if (previousRowCount > 0 || rows.length === 0) {
      return;
    }

    onIsAtEndChange(true);
    const frameId = window.requestAnimationFrame(() => {
      void listRef.current?.scrollToEnd?.({ animated: false });
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [listRef, onIsAtEndChange, rows.length]);

  // Memoised context value — only changes on state transitions, NOT on
  // every streaming chunk. Callbacks from ChatView are useCallback-stable.
  const sharedState = useMemo<TimelineRowSharedState>(
    () => ({
      activeTurnInProgress,
      activeTurnId: activeTurnId ?? null,
      isWorking,
      isRevertingCheckpoint,
      completionSummary,
      timestampFormat,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      activeThreadEnvironmentId,
      hideCheckpointChangedFiles,
      onRevertUserMessage,
      onImageExpand,
      onOpenTurnDiff,
    }),
    [
      activeTurnInProgress,
      activeTurnId,
      isWorking,
      isRevertingCheckpoint,
      completionSummary,
      timestampFormat,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      activeThreadEnvironmentId,
      hideCheckpointChangedFiles,
      onRevertUserMessage,
      onImageExpand,
      onOpenTurnDiff,
    ],
  );

  // Stable renderItem — no closure deps. Row components read shared state
  // from TimelineRowCtx, which propagates through LegendList's memo.
  const renderItem = useCallback(
    ({ item }: { item: MessagesTimelineRow }) => (
      <div className="mx-auto w-full min-w-0 max-w-3xl overflow-x-hidden" data-timeline-root="true">
        <TimelineRowContent row={item} />
      </div>
    ),
    [],
  );

  if (rows.length === 0 && !isWorking) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground/30">
          Send a message to start the conversation.
        </p>
      </div>
    );
  }

  return (
    <TimelineRowCtx.Provider value={sharedState}>
      <LegendList<MessagesTimelineRow>
        ref={listRef}
        data={rows}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        estimatedItemSize={90}
        initialScrollAtEnd
        maintainScrollAtEnd
        maintainScrollAtEndThreshold={0.1}
        maintainVisibleContentPosition
        onScroll={handleScroll}
        className="h-full overflow-x-hidden overscroll-y-contain px-3 sm:px-5"
        ListHeaderComponent={<div className="h-3 sm:h-4" />}
        ListFooterComponent={<div className="h-3 sm:h-4" />}
      />
    </TimelineRowCtx.Provider>
  );
});

function keyExtractor(item: MessagesTimelineRow) {
  return item.id;
}

// ---------------------------------------------------------------------------
// TimelineRowContent — the actual row component
// ---------------------------------------------------------------------------

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];
type TimelineRow = MessagesTimelineRow;

function TimelineRowContent({ row }: { row: TimelineRow }) {
  const ctx = use(TimelineRowCtx);

  return (
    <div
      className={cn(
        "pb-4",
        row.kind === "message" && row.message.role === "assistant" ? "group/assistant" : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "work" && <WorkGroupSection groupedEntries={row.groupedEntries} />}

      {row.kind === "message" &&
        row.message.role === "user" &&
        (() => {
          const userImages = row.message.attachments ?? [];
          const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text);
          const terminalContexts = displayedUserMessage.contexts;
          const canRevertAgentWork = typeof row.revertTurnCount === "number";
          return (
            <div className="flex justify-end">
              <div className="group relative max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3">
                {userImages.length > 0 && (
                  <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
                    {userImages.map(
                      (image: NonNullable<TimelineMessage["attachments"]>[number]) => (
                        <div
                          key={image.id}
                          className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
                        >
                          {image.previewUrl ? (
                            <button
                              type="button"
                              className="h-full w-full cursor-zoom-in"
                              aria-label={`Preview ${image.name}`}
                              onClick={() => {
                                const preview = buildExpandedImagePreview(userImages, image.id);
                                if (!preview) return;
                                ctx.onImageExpand(preview);
                              }}
                            >
                              <img
                                src={image.previewUrl}
                                alt={image.name}
                                className="block h-auto max-h-[220px] w-full object-cover"
                              />
                            </button>
                          ) : (
                            <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
                              {image.name}
                            </div>
                          )}
                        </div>
                      ),
                    )}
                  </div>
                )}
                {(displayedUserMessage.visibleText.trim().length > 0 ||
                  terminalContexts.length > 0) && (
                  <UserMessageBody
                    text={displayedUserMessage.visibleText}
                    terminalContexts={terminalContexts}
                  />
                )}
                <div className="mt-1.5 flex items-center justify-end gap-2">
                  <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                    {displayedUserMessage.copyText && (
                      <MessageCopyButton text={displayedUserMessage.copyText} />
                    )}
                    {canRevertAgentWork && (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={ctx.isRevertingCheckpoint || ctx.isWorking}
                        onClick={() => ctx.onRevertUserMessage(row.message.id)}
                        title="Revert to this message"
                      >
                        <Undo2Icon className="size-3" />
                      </Button>
                    )}
                  </div>
                  <p className="text-right text-xs text-muted-foreground/50">
                    {formatTimestamp(row.message.createdAt, ctx.timestampFormat)}
                  </p>
                </div>
              </div>
            </div>
          );
        })()}

      {row.kind === "message" &&
        row.message.role === "assistant" &&
        (() => {
          const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");
          const assistantTurnStillInProgress =
            ctx.activeTurnInProgress &&
            ctx.activeTurnId !== null &&
            ctx.activeTurnId !== undefined &&
            row.message.turnId === ctx.activeTurnId;
          const assistantCopyState = resolveAssistantMessageCopyState({
            text: row.message.text ?? null,
            showCopyButton: row.showAssistantCopyButton,
            streaming: row.message.streaming || assistantTurnStillInProgress,
          });
          return (
            <>
              {row.showCompletionDivider && (
                <div className="my-3 flex items-center gap-3">
                  <span className="h-px flex-1 bg-border" />
                  <span className="rounded-full border border-border bg-background px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">
                    {ctx.completionSummary ? `Response • ${ctx.completionSummary}` : "Response"}
                  </span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}
              <div className="min-w-0 px-1 py-0.5">
                <ChatMarkdown
                  text={messageText}
                  cwd={ctx.markdownCwd}
                  isStreaming={Boolean(row.message.streaming)}
                />
                {ctx.hideCheckpointChangedFiles && row.assistantTurnDiffSummary ? (
                  <button
                    type="button"
                    className="mt-2 rounded-full border border-border/80 bg-card/60 px-2.5 py-1 text-muted-foreground text-xs transition-colors hover:border-primary/50 hover:text-foreground"
                    onClick={() => ctx.onOpenTurnDiff(row.assistantTurnDiffSummary!.turnId)}
                  >
                    JJ changes
                  </button>
                ) : (
                  <AssistantChangedFilesSection
                    turnSummary={row.assistantTurnDiffSummary}
                    routeThreadKey={ctx.routeThreadKey}
                    resolvedTheme={ctx.resolvedTheme}
                    onOpenTurnDiff={ctx.onOpenTurnDiff}
                  />
                )}
                <div className="mt-1.5 flex items-center gap-2">
                  <p className="text-[10px] text-muted-foreground/30">
                    {row.message.streaming ? (
                      <LiveMessageMeta
                        createdAt={row.message.createdAt}
                        durationStart={row.durationStart}
                        timestampFormat={ctx.timestampFormat}
                      />
                    ) : (
                      formatMessageMeta(
                        row.message.createdAt,
                        formatElapsed(row.durationStart, row.message.completedAt),
                        ctx.timestampFormat,
                      )
                    )}
                  </p>
                  {assistantCopyState.visible ? (
                    <div className="flex items-center opacity-0 transition-opacity duration-200  group-hover/assistant:opacity-100">
                      <MessageCopyButton
                        text={assistantCopyState.text ?? ""}
                        size="icon-xs"
                        variant="outline"
                        className="border-border/50 bg-background/35 text-muted-foreground/45 shadow-none hover:border-border/70 hover:bg-background/55 hover:text-muted-foreground/70"
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            </>
          );
        })()}

      {row.kind === "proposed-plan" && (
        <div className="min-w-0 px-1 py-0.5">
          <ProposedPlanCard
            planMarkdown={row.proposedPlan.planMarkdown}
            environmentId={ctx.activeThreadEnvironmentId}
            cwd={ctx.markdownCwd}
            workspaceRoot={ctx.workspaceRoot}
          />
        </div>
      )}

      {row.kind === "working" && (
        <div className="py-0.5 pl-1.5">
          <div className="flex items-center gap-2 pt-1 text-[11px] text-muted-foreground/70">
            <span className="inline-flex items-center gap-[3px]">
              <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse" />
              <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:200ms]" />
              <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:400ms]" />
            </span>
            <span>
              {row.createdAt ? (
                <>
                  Working for <WorkingTimer createdAt={row.createdAt} />
                </>
              ) : (
                "Working..."
              )}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-ticking components — bypass LegendList memoisation entirely.
// Each owns a `nowMs` state value consumed in the render output so the
// React Compiler cannot elide the re-render as a no-op.
// ---------------------------------------------------------------------------

/** Live "Working for Xs" label. */
function WorkingTimer({ createdAt }: { createdAt: string }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [createdAt]);
  return <>{formatWorkingTimer(createdAt, new Date(nowMs).toISOString()) ?? "0s"}</>;
}

/** Live timestamp + elapsed duration for a streaming assistant message. */
function LiveMessageMeta({
  createdAt,
  durationStart,
  timestampFormat,
}: {
  createdAt: string;
  durationStart: string | null | undefined;
  timestampFormat: TimestampFormat;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [durationStart]);
  const elapsed = durationStart
    ? formatElapsed(durationStart, new Date(nowMs).toISOString())
    : null;
  return <>{formatMessageMeta(createdAt, elapsed, timestampFormat)}</>;
}

// ---------------------------------------------------------------------------
// Extracted row sections — own their state / store subscriptions so changes
// re-render only the affected row, not the entire list.
// ---------------------------------------------------------------------------

/** Owns its own expand/collapse state so toggling re-renders only this row.
 *  State resets on unmount which is fine — work groups start collapsed. */
const WorkGroupSection = memo(function WorkGroupSection({
  groupedEntries,
}: {
  groupedEntries: Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"];
}) {
  const { workspaceRoot, resolvedTheme, onOpenTurnDiff } = use(TimelineRowCtx);
  const [isExpanded, setIsExpanded] = useState(false);
  const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleEntries =
    hasOverflow && !isExpanded
      ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
      : groupedEntries;
  const hiddenCount = groupedEntries.length - visibleEntries.length;
  const onlyToolEntries = groupedEntries.every((entry) => entry.tone === "tool");
  const showHeader = hasOverflow || !onlyToolEntries;
  const groupLabel = onlyToolEntries ? "Tool calls" : "Work log";

  return (
    <div className="rounded-xl border border-border/45 bg-card/25 px-2 py-1.5">
      {showHeader && (
        <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
          <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/55">
            {groupLabel} ({groupedEntries.length})
          </p>
          {hasOverflow && (
            <button
              type="button"
              className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/75"
              onClick={() => setIsExpanded((v) => !v)}
            >
              {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
            </button>
          )}
        </div>
      )}
      <div className="space-y-0.5">
        {visibleEntries.map((workEntry) => (
          <WorkEntryRow
            key={`work-row:${workEntry.id}`}
            workEntry={workEntry}
            workspaceRoot={workspaceRoot}
            resolvedTheme={resolvedTheme}
            onOpenTurnDiff={onOpenTurnDiff}
          />
        ))}
      </div>
    </div>
  );
});

/** Subscribes directly to the UI state store for expand/collapse state,
 *  so toggling re-renders only this component — not the entire list. */
const AssistantChangedFilesSection = memo(function AssistantChangedFilesSection({
  turnSummary,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary | undefined;
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  if (!turnSummary) return null;
  const checkpointFiles = turnSummary.files;
  if (checkpointFiles.length === 0) return null;

  return (
    <AssistantChangedFilesSectionInner
      turnSummary={turnSummary}
      checkpointFiles={checkpointFiles}
      routeThreadKey={routeThreadKey}
      resolvedTheme={resolvedTheme}
      onOpenTurnDiff={onOpenTurnDiff}
    />
  );
});

/** Inner component that only mounts when there are actual changed files,
 *  so the store subscription is unconditional (no hooks after early return). */
function AssistantChangedFilesSectionInner({
  turnSummary,
  checkpointFiles,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary;
  checkpointFiles: TurnDiffSummary["files"];
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  const allDirectoriesExpanded = useUiStateStore(
    (store) => store.threadChangedFilesExpandedById[routeThreadKey]?.[turnSummary.turnId] ?? true,
  );
  const setExpanded = useUiStateStore((store) => store.setThreadChangedFilesExpanded);
  const summaryStat = summarizeTurnDiffStats(checkpointFiles);
  const changedFileCountLabel = String(checkpointFiles.length);

  return (
    <div className="mt-2 rounded-lg border border-border/80 bg-card/45 p-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/65">
          <span>Changed files ({changedFileCountLabel})</span>
          {hasNonZeroStat(summaryStat) && (
            <>
              <span className="mx-1">•</span>
              <DiffStatLabel additions={summaryStat.additions} deletions={summaryStat.deletions} />
            </>
          )}
        </p>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-scroll-anchor-ignore
            onClick={() => setExpanded(routeThreadKey, turnSummary.turnId, !allDirectoriesExpanded)}
          >
            {allDirectoriesExpanded ? "Collapse all" : "Expand all"}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => onOpenTurnDiff(turnSummary.turnId, checkpointFiles[0]?.path)}
          >
            View diff
          </Button>
        </div>
      </div>
      <ChangedFilesTree
        key={`changed-files-tree:${turnSummary.turnId}`}
        turnId={turnSummary.turnId}
        files={checkpointFiles}
        allDirectoriesExpanded={allDirectoriesExpanded}
        resolvedTheme={resolvedTheme}
        onOpenTurnDiff={onOpenTurnDiff}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Leaf components
// ---------------------------------------------------------------------------

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />;
  },
);

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
}) {
  if (props.terminalContexts.length > 0) {
    const hasEmbeddedInlineLabels = textContainsInlineTerminalContextLabels(
      props.text,
      props.terminalContexts,
    );
    const inlinePrefix = buildInlineTerminalContextText(props.terminalContexts);
    const inlineNodes: ReactNode[] = [];

    if (hasEmbeddedInlineLabels) {
      let cursor = 0;

      for (const context of props.terminalContexts) {
        const label = formatInlineTerminalContextLabel(context.header);
        const matchIndex = props.text.indexOf(label, cursor);
        if (matchIndex === -1) {
          inlineNodes.length = 0;
          break;
        }
        if (matchIndex > cursor) {
          inlineNodes.push(
            <span key={`user-terminal-context-inline-before:${context.header}:${cursor}`}>
              {props.text.slice(cursor, matchIndex)}
            </span>,
          );
        }
        inlineNodes.push(
          <UserMessageTerminalContextInlineLabel
            key={`user-terminal-context-inline:${context.header}`}
            context={context}
          />,
        );
        cursor = matchIndex + label.length;
      }

      if (inlineNodes.length > 0) {
        if (cursor < props.text.length) {
          inlineNodes.push(
            <span key={`user-message-terminal-context-inline-rest:${cursor}`}>
              {props.text.slice(cursor)}
            </span>,
          );
        }

        return (
          <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
            {inlineNodes}
          </div>
        );
      }
    }

    for (const context of props.terminalContexts) {
      inlineNodes.push(
        <UserMessageTerminalContextInlineLabel
          key={`user-terminal-context-inline:${context.header}`}
          context={context}
        />,
      );
      inlineNodes.push(
        <span key={`user-terminal-context-inline-space:${context.header}`} aria-hidden="true">
          {" "}
        </span>,
      );
    }

    if (props.text.length > 0) {
      inlineNodes.push(<span key="user-message-terminal-context-inline-text">{props.text}</span>);
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  return (
    <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
      {props.text}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Structural sharing — reuse old row references when data hasn't changed
// so LegendList (and React) can skip re-rendering unchanged items.
// ---------------------------------------------------------------------------

/** Returns a structurally-shared copy of `rows`: for each row whose content
 *  hasn't changed since last call, the previous object reference is reused. */
function useStableRows(rows: MessagesTimelineRow[]): MessagesTimelineRow[] {
  const prevState = useRef<StableMessagesTimelineRowsState>({
    byId: new Map<string, MessagesTimelineRow>(),
    result: [],
  });

  return useMemo(() => {
    const nextState = computeStableMessagesTimelineRows(rows, prevState.current);
    prevState.current = nextState;
    return nextState.result;
  }, [rows]);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatMessageMeta(
  createdAt: string,
  duration: string | null,
  timestampFormat: TimestampFormat,
): string {
  if (!duration) return formatTimestamp(createdAt, timestampFormat);
  return `${formatTimestamp(createdAt, timestampFormat)} • ${duration}`;
}

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  icon: LucideIcon;
  className: string;
} {
  if (tone === "error") {
    return {
      icon: CircleAlertIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "thinking") {
    return {
      icon: BotIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "info") {
    return {
      icon: CheckIcon,
      className: "text-foreground/92",
    };
  }
  return {
    icon: ZapIcon,
    className: "text-foreground/92",
  };
}

function workToneClass(tone: "thinking" | "tool" | "info" | "error"): string {
  if (tone === "error") return "text-rose-300/50 dark:text-rose-300/50";
  if (tone === "tool") return "text-muted-foreground/70";
  if (tone === "thinking") return "text-muted-foreground/50";
  return "text-muted-foreground/40";
}

function workEntryPreview(
  workEntry: Pick<
    TimelineWorkEntry,
    "detail" | "command" | "changedFiles" | "toolContext" | "toolStatus" | "itemType"
  >,
  workspaceRoot: string | undefined,
) {
  if (workEntry.command) return workEntry.command;
  if (workEntry.detail) return workEntry.detail;
  if (workEntry.toolStatus === "running" && workEntry.toolContext?.preview) {
    return workEntry.toolContext.preview;
  }
  if (workEntry.toolContext?.preview) {
    return workEntry.toolContext.preview;
  }
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  const displayPath = formatWorkspaceRelativePath(firstPath, workspaceRoot);
  return workEntry.changedFiles!.length === 1
    ? displayPath
    : `${displayPath} +${workEntry.changedFiles!.length - 1} more`;
}

function workEntryRawCommand(
  workEntry: Pick<TimelineWorkEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

function workEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  if (workEntry.requestKind === "command") return TerminalIcon;
  if (workEntry.requestKind === "file-read") return EyeIcon;
  if (workEntry.requestKind === "file-change") return SquarePenIcon;

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return TerminalIcon;
  }
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return SquarePenIcon;
  }
  if (workEntry.itemType === "web_search") return GlobeIcon;
  if (workEntry.itemType === "image_view") return EyeIcon;

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return WrenchIcon;
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      return HammerIcon;
  }

  return workToneIcon(workEntry.tone).icon;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function isGenericToolHeading(value: string | undefined): boolean {
  if (!value) {
    return true;
  }
  const normalized = normalizeCompactToolLabel(value).trim().toLowerCase();
  return (
    normalized.length === 0 ||
    normalized === "tool updated" ||
    normalized === "tool" ||
    normalized === "tool call"
  );
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  if (workEntry.toolTitle && !isGenericToolHeading(workEntry.toolTitle)) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
  }

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return "Ran command";
  }
  if (
    workEntry.itemType === "file_change" ||
    workEntry.requestKind === "file-change" ||
    (workEntry.toolContext?.fileChanges.length ?? 0) > 0
  ) {
    return "Edited files";
  }
  if (workEntry.requestKind === "file-read") {
    return "Read file";
  }
  if (workEntry.itemType === "web_search") {
    return "Web search";
  }
  if (workEntry.itemType === "mcp_tool_call") {
    return "MCP tool";
  }
  if (workEntry.itemType === "collab_agent_tool_call") {
    return "Agent tool";
  }

  return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
}

function toolStatusChipLabel(
  toolStatus: TimelineWorkEntry["toolStatus"],
): "Running" | "Failed" | null {
  if (toolStatus === "running") {
    return "Running";
  }
  if (toolStatus === "failed") {
    return "Failed";
  }
  return null;
}

function toolStatusChipClassName(toolStatus: TimelineWorkEntry["toolStatus"]): string {
  if (toolStatus === "failed") {
    return "border-rose-500/40 bg-rose-500/12 text-rose-700 dark:text-rose-300";
  }
  return "border-border/70 bg-muted/70 text-foreground/75";
}

function findToolContextField(
  fields: ReadonlyArray<ToolContextField> | undefined,
  label: string,
): ToolContextField | undefined {
  return fields?.find((field) => field.label.toLowerCase() === label.toLowerCase());
}

function isCommandWorkEntry(workEntry: TimelineWorkEntry): boolean {
  return workEntry.itemType === "command_execution" || Boolean(workEntry.command);
}

function inlineCommandDurationText(workEntry: TimelineWorkEntry): string | null {
  if (!isCommandWorkEntry(workEntry)) {
    return null;
  }
  return findToolContextField(workEntry.toolContext?.outputs, "Duration")?.value ?? null;
}

function inlineRunningCommandOutput(workEntry: TimelineWorkEntry): ToolContextField | null {
  if (!isCommandWorkEntry(workEntry) || workEntry.toolStatus !== "running") {
    return null;
  }
  return findToolContextField(workEntry.toolContext?.outputs, "Output") ?? null;
}

function commandOutputField(workEntry: TimelineWorkEntry): ToolContextField | null {
  if (!isCommandWorkEntry(workEntry)) {
    return null;
  }
  return findToolContextField(workEntry.toolContext?.outputs, "Output") ?? null;
}

function truncateToolBlock(
  value: string,
  maxLength: number,
  side: "head" | "tail" = "head",
): {
  value: string;
  truncated: boolean;
  side: "head" | "tail";
} {
  if (value.length <= maxLength) {
    return {
      value,
      truncated: false,
      side,
    };
  }
  if (side === "tail") {
    return {
      value: `[truncated]\n\n${value.slice(-maxLength).trimStart()}`,
      truncated: true,
      side,
    };
  }
  return {
    value: `${value.slice(0, maxLength).trimEnd()}\n\n[truncated]`,
    truncated: true,
    side,
  };
}

function buildCodeFence(value: string, language: string): string {
  const maxBacktickRun = Math.max(
    ...Array.from(value.matchAll(/`+/g), (match) => match[0].length),
    0,
  );
  const fence = "`".repeat(Math.max(3, maxBacktickRun + 1));
  return `${fence}${language}\n${value}\n${fence}`;
}

function toolContextFieldLanguage(field: ToolContextField): string {
  if (field.format === "json") {
    return "json";
  }
  const normalizedLabel = field.label.toLowerCase();
  if (normalizedLabel.includes("command")) {
    return "bash";
  }
  if (normalizedLabel.includes("argument")) {
    return "json";
  }
  return "text";
}

function ToolContextCodeBlock(props: {
  value: string;
  format: ToolContextField["format"];
  maxLength?: number;
  language?: string;
  workspaceRoot: string | undefined;
}) {
  const truncated = props.maxLength ? truncateToolBlock(props.value, props.maxLength) : null;
  const displayedValue = truncated?.value ?? props.value;
  const language = props.language ?? (props.format === "json" ? "json" : "text");

  return (
    <div className="space-y-1.5">
      <div className="[&_.chat-markdown]:text-[11px] [&_.chat-markdown_.chat-markdown-codeblock]:my-0 [&_.chat-markdown_.chat-markdown-shiki_.shiki]:rounded-lg [&_.chat-markdown_pre]:max-h-56 [&_.chat-markdown_pre]:overflow-auto">
        <ChatMarkdown text={buildCodeFence(displayedValue, language)} cwd={props.workspaceRoot} />
      </div>
      {truncated?.truncated ? (
        <div className="px-1 text-[10px] text-muted-foreground/65">
          Showing the {truncated.side === "tail" ? "last" : "first"}{" "}
          {props.maxLength?.toLocaleString()} characters.
        </div>
      ) : null}
    </div>
  );
}

function TerminalTranscriptBlock(props: {
  value: string;
  maxLength?: number;
  viewportClassName?: string;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const snapshotRef = useRef<ReturnType<typeof captureTerminalViewportSnapshot> | null>(null);
  const normalizedValue = useMemo(() => renderTerminalOutput(props.value), [props.value]);
  const truncated = props.maxLength
    ? truncateToolBlock(normalizedValue, props.maxLength, "tail")
    : null;
  const displayedValue = truncated?.value ?? normalizedValue;

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    snapshotRef.current = captureTerminalViewportSnapshot({
      scrollTop: viewport.scrollTop,
      scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
    });
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const previous =
      snapshotRef.current ??
      ({
        scrollTop: 0,
        atBottom: true,
      } satisfies ReturnType<typeof captureTerminalViewportSnapshot>);
    viewport.scrollTop = resolveTerminalViewportScrollTop({
      previous,
      nextScrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
    });
    snapshotRef.current = captureTerminalViewportSnapshot({
      scrollTop: viewport.scrollTop,
      scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
    });
  }, [displayedValue]);

  return (
    <div className="space-y-1.5">
      <div
        ref={viewportRef}
        className={cn(
          "overflow-auto rounded-lg border border-border/50 bg-muted/25",
          props.viewportClassName,
        )}
        data-live-terminal-output="true"
        onScroll={handleScroll}
      >
        <pre className="min-w-full px-3 py-2.5 font-mono text-[11px] leading-4 whitespace-pre-wrap break-words text-foreground/88 tabular-nums">
          {displayedValue}
        </pre>
      </div>
      {truncated?.truncated ? (
        <div className="px-1 text-[10px] text-muted-foreground/65">
          Showing the last {props.maxLength?.toLocaleString()} characters.
        </div>
      ) : null}
    </div>
  );
}

export function CommandHoverTooltipContent(props: { command: string; output: string | null }) {
  return (
    <div className="w-[min(56rem,calc(100vw-2rem))] space-y-2 px-2 py-2">
      <div className="space-y-1">
        <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/65">
          Command
        </p>
        <div className="overflow-x-auto rounded-lg border border-border/50 bg-muted/25 px-3 py-2 font-mono text-[11px] leading-4 whitespace-nowrap text-foreground/88">
          {props.command}
        </div>
      </div>
      {props.output ? (
        <div className="space-y-1">
          <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/65">
            Output
          </p>
          <TerminalTranscriptBlock
            value={props.output}
            maxLength={4_000}
            viewportClassName="max-h-52"
          />
        </div>
      ) : null}
    </div>
  );
}

function LiveCommandDuration({ createdAt }: { createdAt: string }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [createdAt]);
  const elapsed = formatElapsed(createdAt, new Date(nowMs).toISOString());
  return <>{elapsed ?? "0s"}</>;
}

function ToolContextFieldsSection(props: {
  title: string;
  fields: ReadonlyArray<ToolContextField>;
  maxValueLength?: number;
  workspaceRoot: string | undefined;
  terminalFieldLabels?: ReadonlySet<string>;
}) {
  if (props.fields.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/65">
        {props.title}
      </p>
      <div className="space-y-3">
        {props.fields.map((field) => (
          <div key={`${props.title}:${field.label}`} className="space-y-1.5">
            <p className="text-[11px] font-medium text-muted-foreground/80">{field.label}</p>
            {props.terminalFieldLabels?.has(field.label) ? (
              <TerminalTranscriptBlock
                value={field.value}
                {...(props.maxValueLength !== undefined ? { maxLength: props.maxValueLength } : {})}
              />
            ) : field.format === "code" || field.format === "json" ? (
              <ToolContextCodeBlock
                value={field.value}
                format={field.format}
                language={toolContextFieldLanguage(field)}
                workspaceRoot={props.workspaceRoot}
                {...(props.maxValueLength !== undefined ? { maxLength: props.maxValueLength } : {})}
              />
            ) : (
              <p className="text-xs leading-5 text-foreground/85">{field.value}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function buildToolFileChangePatch(
  fileChange: ToolContextPresentation["fileChanges"][number],
): string | undefined {
  const rawDiff = fileChange.diff?.trim();
  if (!rawDiff) {
    return undefined;
  }
  if (rawDiff.startsWith("diff --git")) {
    return rawDiff;
  }

  const normalizedPath = fileChange.path.replaceAll("\\", "/");
  const kind = fileChange.kind?.toLowerCase();
  const previousFile = kind === "create" || kind === "add" ? "/dev/null" : `a/${normalizedPath}`;
  const nextFile = kind === "delete" || kind === "remove" ? "/dev/null" : `b/${normalizedPath}`;

  return [
    `diff --git a/${normalizedPath} b/${normalizedPath}`,
    `--- ${previousFile}`,
    `+++ ${nextFile}`,
    rawDiff,
  ].join("\n");
}

function ToolContextDiffPreview(props: {
  fileChange: ToolContextPresentation["fileChanges"][number];
  resolvedTheme: "light" | "dark";
  workspaceRoot: string | undefined;
}) {
  const synthesizedPatch = buildToolFileChangePatch(props.fileChange);
  const renderablePatch = useMemo(
    () =>
      getRenderablePatch(
        synthesizedPatch,
        `tool-file-change:${props.resolvedTheme}:${props.fileChange.path}`,
      ),
    [props.fileChange.path, props.resolvedTheme, synthesizedPatch],
  );

  if (!renderablePatch) {
    return null;
  }

  if (renderablePatch.kind === "raw") {
    return (
      <div className="space-y-1.5">
        <p className="text-[10px] text-muted-foreground/65">{renderablePatch.reason}</p>
        <ToolContextCodeBlock
          value={renderablePatch.text}
          format="code"
          language="diff"
          maxLength={8_000}
          workspaceRoot={props.workspaceRoot}
        />
      </div>
    );
  }

  return (
    <div className="max-h-80 overflow-auto">
      {renderablePatch.files.map((fileDiff) => (
        <div
          key={
            fileDiff.cacheKey ??
            `${fileDiff.prevName ?? "none"}:${fileDiff.name ?? props.fileChange.path}`
          }
          className="diff-render-file"
          data-diff-file-path={resolveFileDiffPath(fileDiff)}
        >
          <FileDiff
            fileDiff={fileDiff}
            options={{
              diffStyle: "unified",
              lineDiffType: "none",
              overflow: "wrap",
              theme: resolveDiffThemeName(props.resolvedTheme),
              themeType: props.resolvedTheme,
            }}
          />
        </div>
      ))}
    </div>
  );
}

function ToolContextFileChangesSection(props: {
  turnId: TimelineWorkEntry["turnId"];
  fileChanges: ReadonlyArray<ToolContextPresentation["fileChanges"][number]>;
  workspaceRoot: string | undefined;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  if (props.fileChanges.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/65">
        File changes
      </p>
      <div className="divide-y divide-border/40">
        {props.fileChanges.map((fileChange) => {
          const displayPath = formatWorkspaceRelativePath(fileChange.path, props.workspaceRoot);
          return (
            <div
              key={`${fileChange.path}:${fileChange.kind ?? "change"}`}
              className="space-y-2 py-3 first:pt-0 last:pb-0"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[11px] text-foreground/85">{displayPath}</span>
                {fileChange.kind ? (
                  <span className="rounded-full border border-border/55 bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground/70">
                    {fileChange.kind}
                  </span>
                ) : null}
                {props.turnId ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => props.onOpenTurnDiff(props.turnId!, fileChange.path)}
                  >
                    Open full diff
                  </Button>
                ) : null}
              </div>
              {fileChange.diff ? (
                <ToolContextDiffPreview
                  fileChange={fileChange}
                  resolvedTheme={props.resolvedTheme}
                  workspaceRoot={props.workspaceRoot}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ToolContextDetailsPanel(props: {
  toolContext: ToolContextPresentation;
  turnId: TimelineWorkEntry["turnId"];
  workspaceRoot: string | undefined;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  defaultRawPayloadExpanded?: boolean;
}) {
  const [rawPayloadExpanded, setRawPayloadExpanded] = useState(
    props.defaultRawPayloadExpanded ?? false,
  );
  const rawPayload =
    props.toolContext.rawPayload !== undefined
      ? JSON.stringify(props.toolContext.rawPayload, null, 2)
      : null;
  const terminalOutputFieldLabels =
    props.toolContext.heading === "Ran command" ? new Set(["Output"]) : undefined;

  return (
    <div className="mt-2 space-y-4 border-l border-border/45 pl-4">
      <ToolContextFieldsSection
        title="Parameters"
        fields={props.toolContext.parameters}
        workspaceRoot={props.workspaceRoot}
      />
      <ToolContextFieldsSection
        title="Output"
        fields={props.toolContext.outputs}
        maxValueLength={12_000}
        workspaceRoot={props.workspaceRoot}
        {...(terminalOutputFieldLabels ? { terminalFieldLabels: terminalOutputFieldLabels } : {})}
      />
      <ToolContextFileChangesSection
        turnId={props.turnId}
        fileChanges={props.toolContext.fileChanges}
        workspaceRoot={props.workspaceRoot}
        resolvedTheme={props.resolvedTheme}
        onOpenTurnDiff={props.onOpenTurnDiff}
      />
      {rawPayload ? (
        <div className="space-y-2">
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/65 transition-colors hover:text-foreground/80"
            onClick={() => setRawPayloadExpanded((value) => !value)}
          >
            {rawPayloadExpanded ? (
              <ChevronDownIcon className="size-3" />
            ) : (
              <ChevronRightIcon className="size-3" />
            )}
            {rawPayloadExpanded ? "Hide raw payload" : "Show raw payload"}
          </button>
          {rawPayloadExpanded ? (
            <ToolContextCodeBlock
              value={rawPayload}
              format="json"
              language="json"
              workspaceRoot={props.workspaceRoot}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export const WorkEntryRow = memo(function WorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
  resolvedTheme?: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  defaultExpanded?: boolean;
  defaultRawPayloadExpanded?: boolean;
}) {
  const {
    workEntry,
    workspaceRoot,
    resolvedTheme = "light",
    onOpenTurnDiff,
    defaultExpanded = false,
    defaultRawPayloadExpanded = false,
  } = props;
  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const statusChipLabel = toolStatusChipLabel(workEntry.toolStatus);
  const rawPreview = workEntryPreview(workEntry, workspaceRoot);
  const preview =
    rawPreview &&
    normalizeCompactToolLabel(rawPreview).toLowerCase() ===
      normalizeCompactToolLabel(heading).toLowerCase()
      ? null
      : rawPreview;
  const rawCommand = workEntryRawCommand(workEntry);
  const isCommandEntry = isCommandWorkEntry(workEntry);
  const runningCommandOutput = inlineRunningCommandOutput(workEntry);
  const hoverCommandOutput = commandOutputField(workEntry);
  const inlineDuration = inlineCommandDurationText(workEntry);
  const commandDurationContent =
    inlineDuration ??
    (isCommandEntry && workEntry.toolStatus === "running" ? (
      <LiveCommandDuration createdAt={workEntry.createdAt} />
    ) : null);
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const hasChangedFiles = (workEntry.changedFiles?.length ?? 0) > 0;
  const previewIsChangedFiles = hasChangedFiles && !workEntry.command && !workEntry.detail;
  const hideChangedFilePills =
    workEntry.itemType === "file_change" || (workEntry.toolContext?.fileChanges.length ?? 0) > 0;
  const expandable = hasToolContextDetails(workEntry.toolContext);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hoverCommand = rawCommand ?? workEntry.command ?? null;
  const commandHoverTooltip =
    hoverCommand || hoverCommandOutput?.value
      ? {
          command: hoverCommand ?? workEntry.command ?? "",
          output: hoverCommandOutput?.value ?? null,
        }
      : null;

  return (
    <div className="rounded-lg px-1 py-1">
      <div className="flex items-start gap-2 transition-[opacity,translate] duration-200">
        <span
          className={cn("flex size-5 shrink-0 items-center justify-center", iconConfig.className)}
        >
          <EntryIcon className="size-3" />
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          {isCommandEntry && commandHoverTooltip ? (
            <Tooltip>
              <TooltipTrigger
                className="block min-w-0 w-full cursor-default text-left"
                closeDelay={0}
                delay={75}
                title={displayText}
                aria-label={displayText}
              >
                <p
                  className={cn(
                    "truncate text-xs leading-5",
                    workToneClass(workEntry.tone),
                    preview ? "text-muted-foreground/70" : "",
                  )}
                >
                  <span className={cn("text-foreground/80", workToneClass(workEntry.tone))}>
                    {heading}
                  </span>
                  {preview && <span className="text-muted-foreground/55"> - {preview}</span>}
                </p>
              </TooltipTrigger>
              <TooltipPopup
                align="start"
                className="max-w-[min(56rem,calc(100vw-2rem))] px-0 py-0"
                side="top"
              >
                <CommandHoverTooltipContent
                  command={commandHoverTooltip.command}
                  output={commandHoverTooltip.output}
                />
              </TooltipPopup>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger
                className="block min-w-0 w-full text-left"
                title={displayText}
                aria-label={displayText}
              >
                <p
                  className={cn(
                    "truncate text-[11px] leading-5",
                    workToneClass(workEntry.tone),
                    preview ? "text-muted-foreground/70" : "",
                  )}
                >
                  <span className={cn("text-foreground/80", workToneClass(workEntry.tone))}>
                    {heading}
                  </span>
                  {preview && <span className="text-muted-foreground/55"> - {preview}</span>}
                </p>
              </TooltipTrigger>
              <TooltipPopup className="max-w-[min(720px,calc(100vw-2rem))]">
                <p className="whitespace-pre-wrap wrap-break-word text-xs leading-5">
                  {displayText}
                </p>
              </TooltipPopup>
            </Tooltip>
          )}
        </div>
        {statusChipLabel || commandDurationContent || expandable ? (
          <div className="mt-0.5 flex shrink-0 items-center gap-1.5">
            {statusChipLabel ? (
              <span
                className={cn(
                  "inline-flex min-h-5 items-center rounded-full border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em]",
                  toolStatusChipClassName(workEntry.toolStatus),
                )}
              >
                {statusChipLabel}
              </span>
            ) : null}
            {commandDurationContent ? (
              <span className="text-[10px] text-muted-foreground/65 tabular-nums">
                {commandDurationContent}
              </span>
            ) : null}
            {expandable ? (
              <button
                type="button"
                className="inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/65 transition-colors hover:bg-background/80 hover:text-foreground/80"
                aria-label={expanded ? "Hide tool details" : "Show tool details"}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? (
                  <ChevronDownIcon className="size-3.5" />
                ) : (
                  <ChevronRightIcon className="size-3.5" />
                )}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {runningCommandOutput ? (
        <div className="mt-1 pl-6">
          <TerminalTranscriptBlock
            value={runningCommandOutput.value}
            maxLength={4_000}
            viewportClassName="max-h-40"
          />
        </div>
      ) : null}
      {hasChangedFiles && !previewIsChangedFiles && !hideChangedFilePills && (
        <div className="mt-1 flex flex-wrap gap-1 pl-6">
          {workEntry.changedFiles?.slice(0, 4).map((filePath) => {
            const displayPath = formatWorkspaceRelativePath(filePath, workspaceRoot);
            return (
              <span
                key={`${workEntry.id}:${filePath}`}
                className="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/75"
                title={displayPath}
              >
                {displayPath}
              </span>
            );
          })}
          {(workEntry.changedFiles?.length ?? 0) > 4 && (
            <span className="px-1 text-[10px] text-muted-foreground/55">
              +{(workEntry.changedFiles?.length ?? 0) - 4}
            </span>
          )}
        </div>
      )}
      {expanded && workEntry.toolContext ? (
        <div className="pl-6">
          <ToolContextDetailsPanel
            toolContext={workEntry.toolContext}
            turnId={workEntry.turnId}
            workspaceRoot={workspaceRoot}
            resolvedTheme={resolvedTheme}
            onOpenTurnDiff={onOpenTurnDiff}
            defaultRawPayloadExpanded={defaultRawPayloadExpanded}
          />
        </div>
      ) : null}
    </div>
  );
});
