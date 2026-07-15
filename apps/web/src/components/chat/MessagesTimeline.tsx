import {
  type EnvironmentId,
  type MessageId,
  type ScopedThreadRef,
  type ServerProviderSkill,
  type TurnId,
} from "@t3tools/contracts";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { resolveChatListAnchoredEndSpace } from "@t3tools/shared/chatList";
import {
  createContext,
  Fragment,
  memo,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { FileDiff } from "@pierre/diffs/react";
import {
  deriveTimelineEntries,
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workEntryIndicatesToolSuccess,
  workLogEntryIsToolLike,
} from "../../session-logic";
import { type TurnDiffSummary } from "../../types";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import {
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  EyeIcon,
  GitForkIcon,
  GlobeIcon,
  HammerIcon,
  LoaderCircleIcon,
  MessageCircleIcon,
  MousePointerClickIcon,
  PaintbrushIcon,
  MinusIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  resolveTimelineIsAtEnd,
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapHeightStyle,
  resolveTimelineMinimapIndexFromPointer,
  resolveTimelineMinimapTopPercent,
  type StableMessagesTimelineRowsState,
  type MessagesTimelineRow,
  TIMELINE_MINIMAP_MIN_ITEMS,
  type TimelineLatestTurn,
} from "./MessagesTimeline.logic";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import {
  extractTrailingElementContexts,
  type ParsedElementContextEntry,
} from "~/lib/elementContext";
import {
  extractTrailingPreviewAnnotation,
  type ParsedPreviewAnnotation,
} from "~/lib/previewAnnotation";
import { cn } from "~/lib/utils";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { formatChatTimestampTooltip, formatShortTimestamp } from "../../timestampFormat";
import { useAssetUrls } from "../../assets/assetUrls";

import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";
import { SkillInlineText } from "./SkillInlineText";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import {
  buildReviewCommentRenderablePatch,
  formatReviewCommentFence,
  parseReviewCommentMessageSegments,
  type ReviewCommentContext,
} from "../../reviewCommentContext";

// ---------------------------------------------------------------------------
// Context — shared state consumed by every row component via Context.
// Propagates through LegendList's memo boundaries for shared callbacks and
// non-row-scoped state. `nowIso` is intentionally excluded — self-ticking
// components (WorkingTimer, LiveElapsed) handle it.
// ---------------------------------------------------------------------------

interface TimelineRowSharedState {
  timestampFormat: TimestampFormat;
  routeThreadKey: string;
  threadRef: ScopedThreadRef | null;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  workspaceRoot: string | undefined;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  activeThreadEnvironmentId: EnvironmentId;
  canForkAssistantMessage: boolean;
  onRevertUserMessage: (messageId: MessageId) => void;
  onForkAssistantMessage: (
    messageId: MessageId,
    turnId: TurnId,
    options?: { workspace?: "new" },
  ) => void;
  userMessageEditing: UserMessageEditingController;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onOpenSubagentInspector: ((providerThreadId: string) => void) | undefined;
  onToggleTurnFold: (turnId: TurnId) => void;
  onToggleWorkGroup: (groupId: string, anchorElement?: HTMLElement) => void;
}

interface TimelineRowActivityState {
  isWorking: boolean;
  isRevertingCheckpoint: boolean;
  activeTurnInProgress: boolean;
}

const TimelineRowCtx = createContext<TimelineRowSharedState>(null!);
const TimelineRowActivityCtx = createContext<TimelineRowActivityState>(null!);
const TIMELINE_LIST_HEADER = <div className="h-3 sm:h-4" />;
const TIMELINE_LIST_FOOTER = <div className="h-3 sm:h-4" />;
const EMPTY_TIMELINE_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];
const EMPTY_EDITABLE_USER_MESSAGE_IDS: ReadonlySet<MessageId> = new Set();

export interface UserMessageEditingController {
  editingUserMessageId: MessageId | null;
  onEditUserMessage: (messageId: MessageId) => void;
  renderUserMessageEditor: (message: TimelineMessage) => ReactNode;
}

const EMPTY_USER_MESSAGE_EDITING: UserMessageEditingController = {
  editingUserMessageId: null,
  onEditUserMessage: (_messageId: MessageId) => {},
  renderUserMessageEditor: () => null,
};

// ---------------------------------------------------------------------------
// Props (public API)
// ---------------------------------------------------------------------------

interface MessagesTimelineProps {
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  listRef: React.RefObject<LegendListRef | null>;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  latestTurn: TimelineLatestTurn | null;
  runningTurnId: TurnId | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  routeThreadKey: string;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onOpenSubagentInspector?: (providerThreadId: string) => void;
  editableUserMessageIds?: ReadonlySet<MessageId>;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  onForkAssistantMessage?: (
    messageId: MessageId,
    turnId: TurnId,
    options?: { workspace?: "new" },
  ) => void;
  userMessageEditing?: UserMessageEditingController;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  activeThreadEnvironmentId: EnvironmentId;
  canForkAssistantMessage: boolean;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  isLoadingInitialThreadDetail?: boolean;
  anchorMessageId: MessageId | null;
  onAnchorReady: (messageId: MessageId, anchorIndex: number) => void;
  onAnchorSizeChanged: (messageId: MessageId, size: number) => void;
  contentInsetEndAdjustment: number;
  onIsAtEndChange: (isAtEnd: boolean) => void;
  onManualNavigation: () => void;
}

// ---------------------------------------------------------------------------
// MessagesTimeline — list owner
// ---------------------------------------------------------------------------

export const MessagesTimeline = memo(function MessagesTimeline({
  isWorking,
  activeTurnInProgress,
  activeTurnStartedAt,
  listRef,
  timelineEntries,
  latestTurn,
  runningTurnId,
  turnDiffSummaryByAssistantMessageId,
  routeThreadKey,
  onOpenTurnDiff,
  onOpenSubagentInspector,
  editableUserMessageIds = EMPTY_EDITABLE_USER_MESSAGE_IDS,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  onForkAssistantMessage,
  userMessageEditing = EMPTY_USER_MESSAGE_EDITING,
  isRevertingCheckpoint,
  onImageExpand,
  activeThreadEnvironmentId,
  canForkAssistantMessage,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  skills = EMPTY_TIMELINE_SKILLS,
  isLoadingInitialThreadDetail = false,
  anchorMessageId,
  onAnchorReady,
  onAnchorSizeChanged,
  contentInsetEndAdjustment,
  onIsAtEndChange,
  onManualNavigation,
}: MessagesTimelineProps) {
  const [expandedTurnIds, setExpandedTurnIds] = useState<ReadonlySet<TurnId>>(new Set());
  const [expandedWorkGroupIds, setExpandedWorkGroupIds] = useState<ReadonlySet<string>>(new Set());
  const [minimapStripMap] = useState(() => new Map<string, HTMLSpanElement>());

  const onToggleTurnFold = useCallback((turnId: TurnId) => {
    setExpandedTurnIds((existing) => {
      const next = new Set(existing);
      if (next.has(turnId)) {
        next.delete(turnId);
      } else {
        next.add(turnId);
      }
      return next;
    });
  }, []);
  const onToggleWorkGroup = useCallback(
    (groupId: string, anchorElement?: HTMLElement) => {
      const anchorBottomBeforeToggle = anchorElement?.getBoundingClientRect().bottom ?? null;

      flushSync(() => {
        setExpandedWorkGroupIds((existing) => {
          const next = new Set(existing);
          if (next.has(groupId)) {
            next.delete(groupId);
          } else {
            next.add(groupId);
          }
          return next;
        });
      });

      if (anchorBottomBeforeToggle === null || !anchorElement) {
        return;
      }

      const delta = anchorElement.getBoundingClientRect().bottom - anchorBottomBeforeToggle;
      if (Math.abs(delta) < 0.5) {
        return;
      }

      const list = listRef.current;
      const currentScroll = list?.getState?.().scroll;
      if (list && typeof currentScroll === "number") {
        list.scrollToOffset({ offset: currentScroll + delta, animated: false });
      }
    },
    [listRef],
  );

  // An in-session interrupt leaves its turn expanded so the user keeps their
  // place; the next turn (or a reload, since this is local state) folds it.
  const previousLatestTurnRef = useRef(latestTurn);
  useEffect(() => {
    const previous = previousLatestTurnRef.current;
    previousLatestTurnRef.current = latestTurn;
    if (!latestTurn || previous?.turnId === undefined) {
      return;
    }
    if (latestTurn.turnId === previous.turnId) {
      if (previous.state === "running" && latestTurn.state === "interrupted") {
        setExpandedTurnIds((existing) => {
          const next = new Set(existing);
          next.add(latestTurn.turnId);
          return next;
        });
      }
      return;
    }
    setExpandedTurnIds((existing) => {
      if (!existing.has(previous.turnId)) {
        return existing;
      }
      const next = new Set(existing);
      next.delete(previous.turnId);
      return next;
    });
  }, [latestTurn]);

  const rawRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        latestTurn,
        runningTurnId,
        expandedTurnIds,
        expandedWorkGroupIds,
        isWorking,
        activeTurnStartedAt,
        turnDiffSummaryByAssistantMessageId,
        revertTurnCountByUserMessageId,
        editableUserMessageIds,
      }),
    [
      timelineEntries,
      latestTurn,
      runningTurnId,
      expandedTurnIds,
      expandedWorkGroupIds,
      isWorking,
      activeTurnStartedAt,
      editableUserMessageIds,
      turnDiffSummaryByAssistantMessageId,
      revertTurnCountByUserMessageId,
    ],
  );
  const rows = useStableRows(rawRows);
  const minimapItems = useMemo(() => deriveTimelineMinimapItems(rows), [rows]);
  const [timelineViewportElement, setTimelineViewportElement] = useState<HTMLDivElement | null>(
    null,
  );
  const [minimapHasPersistentGutter, setMinimapHasPersistentGutter] = useState(false);
  const handleAnchorReady = useCallback(
    (info: { anchorIndex: number | undefined }) => {
      if (anchorMessageId !== null && info.anchorIndex !== undefined) {
        onAnchorReady(anchorMessageId, info.anchorIndex);
      }
    },
    [anchorMessageId, onAnchorReady],
  );
  const handleAnchorSizeChanged = useCallback(
    (size: number) => {
      if (anchorMessageId !== null) {
        onAnchorSizeChanged(anchorMessageId, size);
      }
    },
    [anchorMessageId, onAnchorSizeChanged],
  );
  const anchoredEndSpace = useMemo(() => {
    const config = resolveChatListAnchoredEndSpace(rows, anchorMessageId, (row) =>
      row.kind === "message" ? row.message.id : null,
    );
    return config
      ? { ...config, onReady: handleAnchorReady, onSizeChanged: handleAnchorSizeChanged }
      : undefined;
  }, [anchorMessageId, handleAnchorReady, handleAnchorSizeChanged, rows]);

  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState?.();
    const isAtEnd = resolveTimelineIsAtEnd(state);
    if (isAtEnd !== undefined) {
      onIsAtEndChange(isAtEnd);
    }
    if (!state || minimapItems.length === 0) {
      return;
    }

    const scrollTop = state.scroll ?? 0;
    const scrollBottom = scrollTop + (state.scrollLength ?? 0);

    for (const item of minimapItems) {
      const strip = minimapStripMap.get(item.id);
      if (!strip) {
        continue;
      }

      const rowTop = resolveTimelineRowTop(state, item.rowIndex);
      const rowHeight = resolveTimelineRowHeight(state, item.rowIndex);
      const inView =
        rowTop !== null &&
        rowTop < scrollBottom &&
        rowTop + Math.max(1, rowHeight ?? 1) > scrollTop;

      strip.dataset.inView = inView ? "true" : "false";
    }
  }, [listRef, minimapItems, minimapStripMap, onIsAtEndChange]);

  useEffect(() => {
    const frame = requestAnimationFrame(handleScroll);
    return () => cancelAnimationFrame(frame);
  }, [handleScroll, rows.length]);

  useEffect(() => {
    if (!timelineViewportElement) {
      return;
    }

    const measure = () => {
      const viewportWidth = timelineViewportElement.getBoundingClientRect().width;
      const nextHasPersistentGutter = resolveTimelineMinimapHasPersistentGutter(viewportWidth);
      setMinimapHasPersistentGutter((current) =>
        current === nextHasPersistentGutter ? current : nextHasPersistentGutter,
      );
    };

    const frame = requestAnimationFrame(measure);

    const observer = new ResizeObserver(measure);
    observer.observe(timelineViewportElement);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [timelineViewportElement, rows.length]);

  const sharedState = useMemo<TimelineRowSharedState>(
    () => ({
      timestampFormat,
      routeThreadKey,
      threadRef: parseScopedThreadKey(routeThreadKey),
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      activeThreadEnvironmentId,
      canForkAssistantMessage,
      onRevertUserMessage,
      onForkAssistantMessage: onForkAssistantMessage ?? (() => {}),
      userMessageEditing,
      onImageExpand,
      onOpenTurnDiff,
      onOpenSubagentInspector,
      onToggleTurnFold,
      onToggleWorkGroup,
    }),
    [
      timestampFormat,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      activeThreadEnvironmentId,
      canForkAssistantMessage,
      onRevertUserMessage,
      onForkAssistantMessage,
      userMessageEditing,
      onImageExpand,
      onOpenTurnDiff,
      onOpenSubagentInspector,
      onToggleTurnFold,
      onToggleWorkGroup,
    ],
  );
  const activityState = useMemo<TimelineRowActivityState>(
    () => ({
      isWorking,
      isRevertingCheckpoint,
      activeTurnInProgress,
    }),
    [activeTurnInProgress, isRevertingCheckpoint, isWorking],
  );

  // Stable renderItem — no closure deps. Row components read shared state
  // from TimelineRowCtx, which propagates through LegendList's memo.
  const renderItem = useCallback(
    ({ item }: { item: MessagesTimelineRow }) => (
      <div className="mx-auto w-full min-w-0 max-w-3xl overflow-x-clip" data-timeline-root="true">
        <TimelineRowContent row={item} />
      </div>
    ),
    [],
  );

  if (rows.length === 0 && isLoadingInitialThreadDetail) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-2 rounded-md border border-border/50 bg-card/60 px-3 py-2 text-muted-foreground text-sm shadow-sm">
          <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground/70" />
          <span>Syncing conversation...</span>
        </div>
      </div>
    );
  }

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
    <TimelineRowCtx value={sharedState}>
      <TimelineRowActivityCtx value={activityState}>
        <div ref={setTimelineViewportElement} className="relative h-full min-h-0">
          <LegendList<MessagesTimelineRow>
            ref={listRef}
            data={rows}
            keyExtractor={keyExtractor}
            getItemType={getItemType}
            renderItem={renderItem}
            estimatedItemSize={90}
            initialScrollAtEnd
            {...(anchoredEndSpace ? { anchoredEndSpace } : {})}
            contentInsetEndAdjustment={contentInsetEndAdjustment}
            maintainScrollAtEnd={
              anchoredEndSpace
                ? false
                : {
                    animated: false,
                    on: {
                      dataChange: true,
                      itemLayout: true,
                      layout: true,
                    },
                  }
            }
            maintainVisibleContentPosition={{
              data: true,
              size: false,
            }}
            onScroll={handleScroll}
            className="scrollbar-gutter-both h-full min-h-0 overflow-x-hidden overscroll-y-contain px-3 [overflow-anchor:none] sm:px-5"
            ListHeaderComponent={TIMELINE_LIST_HEADER}
            ListFooterComponent={TIMELINE_LIST_FOOTER}
          />
          <TimelineMinimap
            items={minimapItems}
            bottomInset={contentInsetEndAdjustment}
            hasPersistentGutter={minimapHasPersistentGutter}
            stripMap={minimapStripMap}
            onSelect={(item) => {
              onManualNavigation();
              void listRef.current?.scrollToIndex({
                index: item.rowIndex,
                animated: true,
                viewOffset: 24,
              });
            }}
          />
        </div>
      </TimelineRowActivityCtx>
    </TimelineRowCtx>
  );
});

function keyExtractor(item: MessagesTimelineRow) {
  return item.id;
}

function getItemType(item: MessagesTimelineRow) {
  return item.kind === "message" ? `message:${item.message.role}` : item.kind;
}

interface TimelineMinimapItem {
  readonly id: string;
  readonly rowIndex: number;
  readonly userText: string | null;
  readonly assistantText: string | null;
}

interface TimelinePositionState {
  readonly contentLength?: number;
  readonly scroll?: number;
  readonly scrollLength?: number;
  readonly positionAtIndex?: (index: number) => number | undefined;
  readonly sizeAtIndex?: (index: number) => number | undefined;
}

function deriveTimelineMinimapItems(
  rows: ReadonlyArray<MessagesTimelineRow>,
): TimelineMinimapItem[] {
  const items: TimelineMinimapItem[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message" || row.message.role !== "user") {
      continue;
    }

    items.push({
      id: row.id,
      rowIndex: index,
      userText: compactMinimapPreview(row.message.text),
      assistantText: compactMinimapPreview(resolveFinalAssistantTextForTurn(rows, index)),
    });
  }
  return items;
}

function resolveFinalAssistantTextForTurn(
  rows: ReadonlyArray<MessagesTimelineRow>,
  userRowIndex: number,
) {
  let finalAssistantText: string | null = null;
  for (let index = userRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message") {
      continue;
    }
    if (row.message.role === "user") {
      break;
    }
    if (row.message.role === "assistant") {
      finalAssistantText = row.message.text ?? null;
    }
  }
  return finalAssistantText;
}

function compactMinimapPreview(text: string | null | undefined) {
  const compact = text?.replace(/\s+/g, " ").trim() ?? "";
  return compact.length > 0 ? compact : null;
}

function resolveTimelineRowTop(state: TimelinePositionState, rowIndex: number) {
  const top = state.positionAtIndex?.(rowIndex);
  return typeof top === "number" && Number.isFinite(top) ? top : null;
}

function resolveTimelineRowHeight(state: TimelinePositionState, rowIndex: number) {
  const height = state.sizeAtIndex?.(rowIndex);
  return typeof height === "number" && Number.isFinite(height) ? height : null;
}

function TimelineMinimap({
  bottomInset,
  hasPersistentGutter,
  items,
  stripMap,
  onSelect,
}: {
  bottomInset: number;
  hasPersistentGutter: boolean;
  items: ReadonlyArray<TimelineMinimapItem>;
  stripMap: Map<string, HTMLSpanElement>;
  onSelect: (item: TimelineMinimapItem) => void;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const resolvedActiveIndex =
    activeIndex !== null && activeIndex < items.length ? activeIndex : null;
  const activeItem = resolvedActiveIndex === null ? null : (items[resolvedActiveIndex] ?? null);
  const activeTopPercent =
    resolvedActiveIndex === null
      ? 0
      : resolveTimelineMinimapTopPercent(resolvedActiveIndex, items.length);
  const activeTooltipTranslate =
    resolvedActiveIndex === null
      ? "-50%"
      : resolvedActiveIndex === 0
        ? "0%"
        : resolvedActiveIndex === items.length - 1
          ? "-100%"
          : "-50%";

  const resolveActiveIndexFromPointer = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      return resolveTimelineMinimapIndexFromPointer({
        itemCount: items.length,
        railTop: rect.top,
        railHeight: rect.height,
        pointerY: event.clientY,
      });
    },
    [items.length],
  );

  const updateActiveIndexFromPointer = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const nextIndex = resolveActiveIndexFromPointer(event);
      setActiveIndex(nextIndex);
    },
    [resolveActiveIndexFromPointer],
  );

  const moveActiveIndex = useCallback(
    (delta: number) => {
      setActiveIndex((current) => {
        const base = current ?? 0;
        return Math.max(0, Math.min(items.length - 1, base + delta));
      });
    },
    [items.length],
  );

  if (items.length < TIMELINE_MINIMAP_MIN_ITEMS) {
    return null;
  }

  const safeBottomInset = Math.max(0, Math.ceil(bottomInset));

  return (
    <div
      className={cn(
        "group/minimap pointer-events-auto absolute top-0 left-0 z-40 hidden w-18 [@media(pointer:fine)]:block",
        hasPersistentGutter
          ? "opacity-100"
          : "opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
      )}
      data-testid="timeline-minimap"
      data-persistent-gutter={hasPersistentGutter ? "true" : "false"}
      style={{ bottom: safeBottomInset }}
    >
      <div className="relative h-full w-full select-none">
        <button
          aria-label={`Jump to message: ${activeItem?.userText ?? "User message"}`}
          className="pointer-events-auto absolute top-1/2 left-3 w-10 -translate-y-1/2 cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          onBlur={() => setActiveIndex(null)}
          onClick={(event) => {
            const nextIndex = resolveActiveIndexFromPointer(event);
            const nextItem = nextIndex === null ? null : (items[nextIndex] ?? null);
            if (nextItem) {
              onSelect(nextItem);
            }
            event.currentTarget.blur();
          }}
          onFocus={() => setActiveIndex((current) => current ?? 0)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveActiveIndex(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              moveActiveIndex(-1);
            } else if (event.key === "Home") {
              event.preventDefault();
              setActiveIndex(0);
            } else if (event.key === "End") {
              event.preventDefault();
              setActiveIndex(items.length - 1);
            } else if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              if (activeItem) {
                onSelect(activeItem);
              }
            }
          }}
          onMouseLeave={() => setActiveIndex(null)}
          onMouseMove={updateActiveIndexFromPointer}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          style={{ height: resolveTimelineMinimapHeightStyle(items.length) }}
          type="button"
        >
          <div className="absolute top-0 left-3 h-full w-px bg-border/15" />
          {items.map((item, index) => {
            const top = `${resolveTimelineMinimapTopPercent(index, items.length)}%`;
            const activeDistance =
              resolvedActiveIndex === null ? null : Math.abs(index - resolvedActiveIndex);
            return (
              <span
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute left-0 h-0.5 -translate-y-1/2 rounded-full bg-muted-foreground/35 transition-[background-color,width] duration-150 data-[in-view=true]:bg-foreground/90",
                  activeDistance === 0
                    ? "w-6 bg-muted-foreground/75"
                    : activeDistance === 1
                      ? "w-4"
                      : activeDistance === 2
                        ? "w-2.5"
                        : "w-2",
                )}
                data-in-view="false"
                data-minimap-strip
                key={item.id}
                ref={(node) => {
                  if (node) {
                    stripMap.set(item.id, node);
                  } else {
                    stripMap.delete(item.id);
                  }
                }}
                style={{ top }}
              />
            );
          })}
          {activeItem ? (
            <span
              className="pointer-events-none absolute left-8 w-80 rounded-xl border border-border/70 bg-popover/95 p-3 text-left text-popover-foreground shadow-xl shadow-black/25 backdrop-blur"
              style={{
                top: `${activeTopPercent}%`,
                transform: `translateY(${activeTooltipTranslate})`,
              }}
            >
              <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium leading-5">
                {activeItem.userText ?? "User message"}
              </span>
              {activeItem.assistantText ? (
                <span
                  className="mt-1 max-h-[3.75rem] overflow-hidden text-muted-foreground text-sm leading-5"
                  style={{
                    display: "-webkit-box",
                    WebkitBoxOrient: "vertical",
                    WebkitLineClamp: 3,
                  }}
                >
                  {activeItem.assistantText}
                </span>
              ) : null}
            </span>
          ) : null}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TimelineRowContent — the actual row component
// ---------------------------------------------------------------------------

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];
type TimelineRow = MessagesTimelineRow;

const TimelineRowContent = memo(function TimelineRowContent({ row }: { row: TimelineRow }) {
  return (
    <div
      className={cn(
        // Commentary (non-terminal assistant) rows carry no metadata row, so
        // they sit closer to the work that follows them.
        (row.kind === "message" && row.message.role === "assistant" && !row.showAssistantMeta) ||
          row.kind === "work" ||
          row.kind === "work-toggle"
          ? "pb-2"
          : "pb-4",
        row.kind === "message" && row.message.role === "assistant" ? "group/assistant" : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "work" ? <WorkGroupSection groupedEntries={row.groupedEntries} /> : null}
      {row.kind === "work-toggle" ? <WorkGroupToggleTimelineRow row={row} /> : null}
      {row.kind === "turn-fold" ? <TurnFoldTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "user" ? <UserTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "assistant" ? (
        <AssistantTimelineRow row={row} />
      ) : null}
      {row.kind === "proposed-plan" ? <ProposedPlanTimelineRow row={row} /> : null}
      {row.kind === "working" ? <WorkingTimelineRow row={row} /> : null}
    </div>
  );
});

function UserTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const userImages = row.message.attachments ?? [];
  const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text);
  const terminalContexts = displayedUserMessage.contexts;
  const previewAnnotations: ParsedPreviewAnnotation[] = [];
  let visibleText = displayedUserMessage.visibleText;
  while (true) {
    const extracted = extractTrailingPreviewAnnotation(visibleText);
    if (!extracted.annotation) break;
    previewAnnotations.unshift(extracted.annotation);
    visibleText = extracted.promptText;
  }
  const elementContextState = extractTrailingElementContexts(visibleText);
  const elementContexts = [
    ...displayedUserMessage.elementContexts,
    ...elementContextState.contexts,
  ];
  const previewImages = userImages.filter((image) => image.name.startsWith("preview-annotation-"));
  const regularImages = userImages.filter((image) => !image.name.startsWith("preview-annotation-"));
  const canEditUserMessage = row.canEditUserMessage;
  const canRevertAgentWork = typeof row.revertTurnCount === "number";
  const isEditing = ctx.userMessageEditing.editingUserMessageId === row.message.id;

  if (isEditing) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="w-full max-w-[80%]">
          {ctx.userMessageEditing.renderUserMessageEditor(row.message)}
        </div>
      </div>
    );
  }

  return (
    <div className="group flex flex-col items-end gap-1">
      <div className="relative max-w-[80%] rounded-2xl border border-border bg-secondary p-3">
        {regularImages.length > 0 && (
          <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
            {regularImages.map((image: NonNullable<TimelineMessage["attachments"]>[number]) => (
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
                      const preview = buildExpandedImagePreview(regularImages, image.id);
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
            ))}
          </div>
        )}
        {previewAnnotations.map((annotation, index) => (
          <UserMessagePreviewAnnotationCard
            key={annotation.id}
            annotation={annotation}
            image={previewImages[index] ?? null}
          />
        ))}
        {elementContexts.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {elementContexts.map((context) => (
              <UserMessageElementContextChip
                key={`${context.header}:${context.body}`}
                context={context}
              />
            ))}
          </div>
        ) : null}
        <CollapsibleUserMessageBody
          text={elementContextState.promptText}
          terminalContexts={terminalContexts}
          skills={ctx.skills}
          markdownCwd={ctx.markdownCwd}
        />
      </div>
      <div className="flex w-full max-w-[80%] items-center justify-end pe-1 text-xs tabular-nums opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
        <div className="flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger render={<p className="text-muted-foreground text-xs tabular-nums" />}>
              {formatShortTimestamp(row.message.createdAt, ctx.timestampFormat)}
            </TooltipTrigger>
            <TooltipPopup>
              {formatChatTimestampTooltip(row.message.createdAt, ctx.timestampFormat)}
            </TooltipPopup>
          </Tooltip>
          <div className="flex items-center gap-0.5">
            {canEditUserMessage && <EditUserMessageButton messageId={row.message.id} />}
            {canRevertAgentWork && <RevertUserMessageButton messageId={row.message.id} />}
            {displayedUserMessage.copyText && (
              <MessageCopyButton text={displayedUserMessage.copyText} variant="ghost" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function EditUserMessageButton({ messageId }: { messageId: MessageId }) {
  const ctx = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={
              activity.isRevertingCheckpoint ||
              activity.isWorking ||
              ctx.userMessageEditing.editingUserMessageId !== null
            }
            onClick={() => ctx.userMessageEditing.onEditUserMessage(messageId)}
            aria-label="Edit message"
          />
        }
      >
        <SquarePenIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">Edit message</TooltipPopup>
    </Tooltip>
  );
}

function RevertUserMessageButton({ messageId }: { messageId: MessageId }) {
  const ctx = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={activity.isRevertingCheckpoint || activity.isWorking}
            onClick={() => ctx.onRevertUserMessage(messageId)}
            aria-label="Revert to this message"
          />
        }
      >
        <Undo2Icon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">Revert to this message</TooltipPopup>
    </Tooltip>
  );
}

function TurnFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "turn-fold" }> }) {
  const ctx = use(TimelineRowCtx);
  const Icon = row.expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div className="border-b border-border/60 pb-2 pt-1">
      <button
        type="button"
        aria-expanded={row.expanded}
        data-scroll-anchor-ignore
        onClick={() => ctx.onToggleTurnFold(row.turnId)}
        className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-xs text-muted-foreground tabular-nums transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <span>{row.label}</span>
        <Icon className="size-3.5" />
      </button>
    </div>
  );
}

function AssistantTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");

  return (
    <>
      <div className="relative min-w-0 px-1 py-0.5">
        <ChatMarkdown
          text={messageText}
          cwd={ctx.markdownCwd}
          environmentId={ctx.activeThreadEnvironmentId}
          threadRef={ctx.threadRef ?? undefined}
          isStreaming={Boolean(row.message.streaming)}
          skills={ctx.skills}
        />
        <AssistantChangedFilesSection
          turnSummary={row.assistantTurnDiffSummary}
          onOpenTurnDiff={ctx.onOpenTurnDiff}
        />
        {row.showAssistantMeta ? (
          <div className="mt-1.5 flex items-center gap-2 text-xs tabular-nums opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/assistant:opacity-100">
            <AssistantCopyButton row={row} />
            <AssistantForkButton row={row} />
            {!row.message.streaming && (
              <Tooltip>
                <TooltipTrigger
                  render={<p className="text-muted-foreground text-xs tabular-nums" />}
                >
                  {formatShortTimestamp(row.message.updatedAt, ctx.timestampFormat)}
                </TooltipTrigger>
                <TooltipPopup>
                  {formatChatTimestampTooltip(row.message.updatedAt, ctx.timestampFormat)}
                </TooltipPopup>
              </Tooltip>
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}

function AssistantCopyButton({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const assistantCopyState = resolveAssistantMessageCopyState({
    text: row.message.text ?? null,
    showCopyButton: row.showAssistantCopyButton,
    streaming: row.assistantCopyStreaming,
  });

  if (!assistantCopyState.visible) {
    return null;
  }

  return <MessageCopyButton text={assistantCopyState.text ?? ""} variant="ghost" />;
}

function AssistantForkButton({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);
  const turnId = row.message.turnId;
  if (!turnId || !ctx.canForkAssistantMessage) {
    return null;
  }

  const disabled = activity.activeTurnInProgress || activity.isWorking;
  if (disabled) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button type="button" size="xs" variant="ghost" disabled aria-label="Fork from here" />
          }
        >
          <GitForkIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="top">Fork is available when the thread is idle</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Menu>
      <MenuTrigger
        render={<Button type="button" size="xs" variant="ghost" aria-label="Fork from here" />}
      >
        <GitForkIcon className="size-3" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => ctx.onForkAssistantMessage(row.message.id, turnId)}>
          Fork here
        </MenuItem>
        <MenuItem
          onClick={() => ctx.onForkAssistantMessage(row.message.id, turnId, { workspace: "new" })}
        >
          Fork into new workspace
        </MenuItem>
        <MenuItem disabled>Fork to host...</MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function ProposedPlanTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "proposed-plan" }>;
}) {
  const ctx = use(TimelineRowCtx);

  return (
    <div className="min-w-0 px-1 py-0.5">
      <ProposedPlanCard
        planMarkdown={row.proposedPlan.planMarkdown}
        environmentId={ctx.activeThreadEnvironmentId}
        threadRef={ctx.threadRef ?? undefined}
        cwd={ctx.markdownCwd}
        workspaceRoot={ctx.workspaceRoot}
      />
    </div>
  );
}

function WorkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "working" }> }) {
  return (
    <div className="py-0.5 pl-1.5">
      <div className="flex items-center gap-2 pt-1 text-[11px] text-muted-foreground/70 tabular-nums">
        <span className="inline-flex items-center gap-[3px]">
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse" />
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse [animation-delay:200ms]" />
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse [animation-delay:400ms]" />
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
  );
}

// ---------------------------------------------------------------------------
// Self-ticking labels — update their own text nodes so elapsed-time display
// does not create a React commit every second while a response is streaming.
// ---------------------------------------------------------------------------

/** Live "Working for Xs" label. */
function WorkingTimer({ createdAt }: { createdAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatWorkingTimerNow(createdAt);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatWorkingTimerNow(createdAt);
      }
    };
    updateText();
    const id = setInterval(updateText, 1000);
    return () => clearInterval(id);
  }, [createdAt]);

  return (
    <span ref={textRef} className="tabular-nums">
      {initialText}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Extracted row sections — own their state / store subscriptions so changes
// re-render only the affected row, not the entire list.
// ---------------------------------------------------------------------------

/** Renders one or more already-derived work log rows. Overflow expansion is modeled as LegendList data. */
const WorkGroupSection = memo(function WorkGroupSection({
  groupedEntries,
}: {
  groupedEntries: Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"];
}) {
  const { workspaceRoot } = use(TimelineRowCtx);
  const nonEmptyEntries = useMemo(
    () => groupedEntries.filter((entry) => !workEntryIndicatesToolNeutralStatus(entry)),
    [groupedEntries],
  );
  const onlyToolEntries = nonEmptyEntries.every((entry) => workLogEntryIsToolLike(entry));
  const groupLabel = onlyToolEntries
    ? nonEmptyEntries.length === 1
      ? "1 tool call"
      : `${nonEmptyEntries.length} tool calls`
    : "Work Log";

  if (nonEmptyEntries.length === 0) return null;

  return (
    <section className="-mx-1 space-y-0.5 px-1 py-0.5" aria-label={groupLabel}>
      {!onlyToolEntries && (
        <p className="px-0.5 pb-0.5 font-medium text-[11px] text-muted-foreground/65">
          {groupLabel}
        </p>
      )}
      <div className="space-y-px">
        {nonEmptyEntries.map((workEntry) => (
          <SimpleWorkEntryRow
            key={workEntry.id}
            workEntry={workEntry}
            workspaceRoot={workspaceRoot}
          />
        ))}
      </div>
    </section>
  );
});

function WorkGroupToggleTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "work-toggle" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const labelNoun = row.onlyToolEntries ? "tool call" : "log entry";

  return (
    <button
      type="button"
      className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-[12px] leading-5 transition-colors duration-150 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      aria-expanded={row.expanded}
      onClick={(event) => {
        const anchorElement =
          event.currentTarget.closest<HTMLElement>("[data-timeline-row-id]") ?? event.currentTarget;
        ctx.onToggleWorkGroup(row.groupId, anchorElement);
      }}
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground/65">
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 opacity-70 transition-transform duration-200",
            row.expanded && "rotate-180",
          )}
        />
      </span>
      {row.expanded ? (
        <span className="font-medium text-foreground/82">
          Show fewer {row.onlyToolEntries ? "tool calls" : "log entries"}
        </span>
      ) : (
        <span className="font-medium text-foreground/82">
          +{row.hiddenCount} previous {labelNoun}
          {row.hiddenCount === 1 ? "" : "s"}
        </span>
      )}
    </button>
  );
}

const AssistantChangedFilesSection = memo(function AssistantChangedFilesSection({
  turnSummary,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary | undefined;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  if (!turnSummary) return null;
  const checkpointFiles = turnSummary.files;
  if (checkpointFiles.length === 0) return null;
  const summaryStat = summarizeTurnDiffStats(checkpointFiles);
  const changedFileCountLabel = String(checkpointFiles.length);
  const [firstChangedFile] = checkpointFiles;

  return (
    <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted/25 px-2.5 py-1.5">
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <SquarePenIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground/75" />
        <p className="min-w-0 truncate">
          <span className="font-medium text-foreground/82">
            Changed {changedFileCountLabel} file{checkpointFiles.length === 1 ? "" : "s"}
          </span>
          {hasNonZeroStat(summaryStat) && (
            <>
              <span className="mx-1.5 text-muted-foreground/60">•</span>
              <DiffStatLabel
                additions={summaryStat.additions}
                className="text-[11px]"
                deletions={summaryStat.deletions}
                layout="inline"
              />
            </>
          )}
        </p>
      </div>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        className="shrink-0"
        onClick={() => onOpenTurnDiff(turnSummary.turnId, firstChangedFile?.path)}
      >
        View diff
      </Button>
    </div>
  );
});

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

const UserMessageElementContextChip = memo(function UserMessageElementContextChip(props: {
  context: ParsedElementContextEntry;
}) {
  const tooltipText = props.context.body
    ? `${props.context.header}\n${props.context.body}`
    : props.context.header;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-background/70 px-1.5 py-0.5 text-xs text-foreground/85">
            <MousePointerClickIcon className="size-3 shrink-0" />
            <span className="truncate">{props.context.header}</span>
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap leading-tight">
        {tooltipText}
      </TooltipPopup>
    </Tooltip>
  );
});

function UserMessagePreviewAnnotationCard(props: {
  annotation: ParsedPreviewAnnotation;
  image: NonNullable<TimelineMessage["attachments"]>[number] | null;
}) {
  const ctx = use(TimelineRowCtx);
  return (
    <div className="mb-2 flex max-w-full items-center overflow-hidden rounded-lg border border-border/70 bg-background/70">
      {props.image?.previewUrl ? (
        <button
          type="button"
          className="size-14 shrink-0 cursor-zoom-in overflow-hidden border-r border-border/70 bg-muted"
          aria-label={`Preview ${props.image.name}`}
          onClick={() => {
            if (!props.image) return;
            const preview = buildExpandedImagePreview([props.image], props.image.id);
            if (preview) ctx.onImageExpand(preview);
          }}
        >
          <img
            src={props.image.previewUrl}
            alt="Annotated preview crop"
            className="size-full object-cover"
          />
        </button>
      ) : null}
      <div className="min-w-0 px-2.5 py-2">
        {props.annotation.comment ? (
          <div className="max-w-80 truncate text-xs font-medium text-foreground/90">
            {props.annotation.comment}
          </div>
        ) : null}
        <div
          className={cn(
            "flex items-center gap-2 text-[10px] text-muted-foreground",
            props.annotation.comment && "mt-1",
          )}
        >
          {props.annotation.targetSummary ? (
            <span className="truncate">{props.annotation.targetSummary}</span>
          ) : null}
          {props.annotation.styleChanges.length > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1">
              <PaintbrushIcon className="size-3" />
              {props.annotation.styleChanges.length}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const MAX_COLLAPSED_USER_MESSAGE_LINES = 8;
const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600;
const COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM = 1.75;
const COLLAPSED_USER_MESSAGE_FADE_MASK = `linear-gradient(to bottom, black calc(100% - ${COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM}rem), transparent)`;

function shouldCollapseUserMessage(text: string): boolean {
  if (text.trim().length === 0) {
    return false;
  }

  return (
    text.length > MAX_COLLAPSED_USER_MESSAGE_LENGTH ||
    text.split("\n").length > MAX_COLLAPSED_USER_MESSAGE_LINES
  );
}

const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  markdownCwd: string | undefined;
  footer?: ReactNode;
}) {
  const ctx = use(TimelineRowCtx);
  const [expanded, setExpanded] = useState(false);
  const hasVisibleBody = props.text.trim().length > 0 || props.terminalContexts.length > 0;
  const canCollapse = hasVisibleBody && shouldCollapseUserMessage(props.text);
  const isCollapsed = canCollapse && !expanded;

  return (
    <div>
      {hasVisibleBody ? (
        <div
          className={cn("relative", isCollapsed && "max-h-44 overflow-hidden")}
          data-user-message-body="true"
          data-user-message-collapsed={isCollapsed ? "true" : "false"}
          data-user-message-collapsible={canCollapse ? "true" : "false"}
          data-user-message-fade={isCollapsed ? "true" : "false"}
          style={
            isCollapsed
              ? {
                  WebkitMaskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                  maskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                }
              : undefined
          }
        >
          <UserMessageBody
            text={props.text}
            terminalContexts={props.terminalContexts}
            skills={props.skills}
            markdownCwd={props.markdownCwd}
            environmentId={ctx.activeThreadEnvironmentId}
          />
        </div>
      ) : null}
      {canCollapse || props.footer ? (
        <div
          className={cn(
            "mt-1.5 flex items-center gap-2",
            canCollapse && props.footer ? "justify-between" : "justify-end",
          )}
          data-user-message-footer="true"
        >
          {canCollapse ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-expanded={expanded}
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
              className="-ml-1 h-6 rounded-md px-1.5 text-xs text-muted-foreground/72 hover:bg-muted/55 hover:text-foreground/85"
            >
              {expanded ? "Show less" : "Show full message"}
            </Button>
          ) : null}
          {props.footer ? (
            <div className="ml-auto flex items-center gap-2">{props.footer}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  markdownCwd: string | undefined;
  environmentId: EnvironmentId;
}) {
  const ctx = use(TimelineRowCtx);
  const renderInlineMarkdownSegment = (text: string, key: string) => {
    const leadingWhitespace = /^\s+/.exec(text)?.[0] ?? "";
    const textWithoutLeadingWhitespace = text.slice(leadingWhitespace.length);
    const trailingWhitespace = /\s+$/.exec(textWithoutLeadingWhitespace)?.[0] ?? "";
    const content = textWithoutLeadingWhitespace.slice(
      0,
      textWithoutLeadingWhitespace.length - trailingWhitespace.length,
    );

    return (
      <Fragment key={key}>
        {leadingWhitespace ? <span aria-hidden="true">{leadingWhitespace}</span> : null}
        {content ? (
          <ChatMarkdown
            text={content}
            cwd={props.markdownCwd}
            environmentId={props.environmentId}
            threadRef={ctx.threadRef ?? undefined}
            skills={props.skills}
            className="text-foreground"
            lineBreaks
          />
        ) : null}
        {trailingWhitespace ? <span aria-hidden="true">{trailingWhitespace}</span> : null}
      </Fragment>
    );
  };

  const reviewCommentSegments = parseReviewCommentMessageSegments(props.text);
  if (reviewCommentSegments.some((segment) => segment.kind === "review-comment")) {
    return (
      <div className="space-y-3 text-sm leading-relaxed text-foreground">
        {reviewCommentSegments.map((segment) =>
          segment.kind === "text" ? (
            segment.text.trim().length > 0 ? (
              <div key={segment.id} className="wrap-break-word">
                <ChatMarkdown
                  text={segment.text.trim()}
                  cwd={props.markdownCwd}
                  environmentId={props.environmentId}
                  threadRef={ctx.threadRef ?? undefined}
                  skills={props.skills}
                  className="text-foreground"
                  lineBreaks
                />
              </div>
            ) : null
          ) : (
            <UserMessageReviewCommentCard key={segment.comment.id} comment={segment.comment} />
          ),
        )}
      </div>
    );
  }

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
            renderInlineMarkdownSegment(
              props.text.slice(cursor, matchIndex),
              `user-terminal-context-inline-before:${context.header}:${cursor}`,
            ),
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
            renderInlineMarkdownSegment(
              props.text.slice(cursor),
              `user-message-terminal-context-inline-rest:${cursor}`,
            ),
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
      inlineNodes.push(
        <ChatMarkdown
          key="user-message-terminal-context-inline-text"
          text={props.text}
          cwd={props.markdownCwd}
          environmentId={props.environmentId}
          threadRef={ctx.threadRef ?? undefined}
          skills={props.skills}
          className="text-foreground"
          lineBreaks
        />,
      );
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
    <ChatMarkdown
      text={props.text}
      cwd={props.markdownCwd}
      environmentId={props.environmentId}
      threadRef={ctx.threadRef ?? undefined}
      skills={props.skills}
      className="text-foreground"
      lineBreaks
    />
  );
});

function UserMessageReviewCommentCard({ comment }: { comment: ReviewCommentContext }) {
  const ctx = use(TimelineRowCtx);
  const fenceLanguage = comment.fenceLanguage ?? "diff";
  const renderablePatch = getRenderablePatch(
    buildReviewCommentRenderablePatch(comment),
    `review-comment:${comment.id}`,
  );

  return (
    <div className="space-y-2 rounded-lg border border-border/70 bg-background/70 p-3">
      <div className="space-y-1">
        <div className="text-xs font-medium text-foreground">
          {formatWorkspaceRelativePath(comment.filePath, ctx.workspaceRoot)}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {comment.sectionTitle} · {comment.rangeLabel}
        </div>
      </div>
      {comment.text.length > 0 && (
        <div className="whitespace-pre-wrap wrap-break-word text-sm">
          <SkillInlineText text={comment.text} skills={ctx.skills} />
        </div>
      )}
      {fenceLanguage !== "diff" && comment.diff.trim().length > 0 && (
        <ChatMarkdown
          text={formatReviewCommentFence(fenceLanguage, comment.diff)}
          cwd={ctx.markdownCwd}
          threadRef={ctx.threadRef ?? undefined}
          skills={ctx.skills}
          className="text-foreground"
        />
      )}
      {renderablePatch?.kind === "files" &&
        renderablePatch.files.map((fileDiff) => (
          <FileDiff
            key={resolveFileDiffPath(fileDiff)}
            fileDiff={fileDiff}
            options={{
              collapsed: false,
              diffStyle: "unified",
              theme: resolveDiffThemeName(ctx.resolvedTheme),
            }}
          />
        ))}
      {renderablePatch?.kind === "raw" && (
        <pre className="overflow-x-auto rounded-md bg-muted/40 p-2 text-xs">
          {renderablePatch.text}
        </pre>
      )}
    </div>
  );
}

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

function formatWorkingTimerNow(startIso: string): string {
  return formatWorkingTimer(startIso, new Date().toISOString()) ?? "0s";
}

type WorkEntryIconName =
  | "bot"
  | "check"
  | "circle-alert"
  | "eye"
  | "globe"
  | "hammer"
  | "message-circle"
  | "square-pen"
  | "terminal"
  | "wrench"
  | "x"
  | "zap";

function WorkEntryIconSvg({ name, className }: { name: WorkEntryIconName; className: string }) {
  switch (name) {
    case "bot":
      return <BotIcon className={className} aria-hidden />;
    case "check":
      return <CheckIcon className={className} aria-hidden />;
    case "circle-alert":
      return <CircleAlertIcon className={className} aria-hidden />;
    case "eye":
      return <EyeIcon className={className} aria-hidden />;
    case "globe":
      return <GlobeIcon className={className} aria-hidden />;
    case "hammer":
      return <HammerIcon className={className} aria-hidden />;
    case "message-circle":
      return <MessageCircleIcon className={className} aria-hidden />;
    case "square-pen":
      return <SquarePenIcon className={className} aria-hidden />;
    case "terminal":
      return <TerminalIcon className={className} aria-hidden />;
    case "wrench":
      return <WrenchIcon className={className} aria-hidden />;
    case "x":
      return <XIcon className={className} aria-hidden />;
    case "zap":
      return <ZapIcon className={className} aria-hidden />;
  }
}

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  iconName: WorkEntryIconName;
  className: string;
} {
  if (tone === "error") {
    return {
      iconName: "circle-alert",
      className: "text-foreground/92",
    };
  }
  if (tone === "thinking") {
    return {
      iconName: "bot",
      className: "text-foreground/92",
    };
  }
  if (tone === "info") {
    return {
      iconName: "check",
      className: "text-muted-foreground",
    };
  }
  return {
    iconName: "zap",
    className: "text-foreground/92",
  };
}

function workEntryPreview(
  workEntry: Pick<TimelineWorkEntry, "detail" | "command" | "changedFiles" | "subagent" | "media">,
  workspaceRoot: string | undefined,
) {
  if (workEntry.subagent?.prompt) return workEntry.subagent.prompt;
  if (workEntry.subagent?.lastActivity) return workEntry.subagent.lastActivity;
  if (workEntry.command) return workEntry.command;
  if (workEntry.detail) return workEntry.detail;
  if ((workEntry.media?.length ?? 0) > 0) {
    const [firstMedia] = workEntry.media ?? [];
    return workEntry.media!.length === 1
      ? (firstMedia?.name ?? "Image")
      : `${firstMedia?.name ?? "Image"} +${workEntry.media!.length - 1} more`;
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

function buildToolCallExpandedBody(
  workEntry: TimelineWorkEntry,
  workspaceRoot: string | undefined,
): string | null {
  const blocks: string[] = [];
  if (workEntry.itemType === "mcp_tool_call" && workEntry.toolData !== undefined) {
    blocks.push(`MCP call\n${JSON.stringify(workEntry.toolData, null, 2)}`);
  }
  const raw = workEntryRawCommand(workEntry);
  if (raw?.trim()) {
    blocks.push(raw.trim());
  } else if (workEntry.command?.trim()) {
    blocks.push(workEntry.command.trim());
  }
  if (workEntry.detail?.trim()) {
    blocks.push(workEntry.detail.trim());
  }
  const changedFiles = workEntry.changedFiles ?? [];
  if (changedFiles.length > 0) {
    blocks.push(
      changedFiles
        .map((filePath) => formatWorkspaceRelativePath(filePath, workspaceRoot))
        .join("\n"),
    );
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

function workEntryIconName(workEntry: TimelineWorkEntry): WorkEntryIconName {
  if (workEntry.subagent) return "bot";
  if (
    workEntry.sourceActivityKind === "user-input.requested" ||
    workEntry.sourceActivityKind === "user-input.resolved"
  ) {
    return "message-circle";
  }
  if (workEntry.requestKind === "command") return "terminal";
  if (workEntry.requestKind === "file-read") return "eye";
  if (workEntry.requestKind === "file-change") return "square-pen";

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return "terminal";
  }
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return "square-pen";
  }
  if (workEntry.itemType === "web_search") return "globe";
  if (workEntry.itemType === "image_view") return "eye";

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return "wrench";
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      return "hammer";
  }

  return workToneIcon(workEntry.tone).iconName;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  if (workEntry.subagent) {
    return workEntry.subagent.label;
  }
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

const stopRowToggle = (e: { stopPropagation: () => void }) => e.stopPropagation();

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
}) {
  const ctx = use(TimelineRowCtx);
  const { onOpenSubagentInspector } = ctx;
  const { workEntry, workspaceRoot } = props;
  const subagent = workEntry.subagent;
  const activity = use(TimelineRowActivityCtx);
  const [expanded, setExpanded] = useState(false);
  const observedMediaResources = useMemo(
    () =>
      (workEntry.media ?? []).map((media) => ({
        _tag: "observed-media" as const,
        storageId: media.storageId,
      })),
    [workEntry.media],
  );
  const observedMediaUrls = useAssetUrls(ctx.activeThreadEnvironmentId, observedMediaResources);
  const observedMediaPreviews = useMemo(
    () =>
      (workEntry.media ?? []).flatMap((media, index) => {
        const previewUrl = observedMediaUrls[index];
        return previewUrl
          ? [
              {
                id: media.id,
                name: media.name,
                previewUrl,
              },
            ]
          : [];
      }),
    [observedMediaUrls, workEntry.media],
  );
  const iconConfig = workToneIcon(workEntry.tone);
  const showWarningIndicator = workEntry.sourceActivityKind === "runtime.warning";
  const entryIconName = showWarningIndicator ? "x" : workEntryIconName(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const rawPreview = workEntryPreview(workEntry, workspaceRoot);
  const preview =
    rawPreview &&
    normalizeCompactToolLabel(rawPreview).toLowerCase() ===
      normalizeCompactToolLabel(heading).toLowerCase()
      ? null
      : rawPreview;
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const expandedBody = buildToolCallExpandedBody(workEntry, workspaceRoot);
  const hasObservedMediaPreviews = observedMediaPreviews.length > 0;
  const canExpand = expandedBody !== null || hasObservedMediaPreviews;
  const subagentStatus = subagent ? formatSubagentStatus(subagent.status) : null;
  const showFailedIndicator = workEntryIndicatesToolFailure(workEntry);
  const showDestructiveRowStyle =
    showFailedIndicator &&
    (workEntry.sourceActivityKind === "runtime.error" || !workLogEntryIsToolLike(workEntry));
  const iconWrapperClass = cn(
    "flex size-5 shrink-0 items-center justify-center",
    showWarningIndicator
      ? "text-destructive"
      : showDestructiveRowStyle
        ? "text-destructive"
        : workEntry.tone === "tool" || showFailedIndicator
          ? "text-muted-foreground/65"
          : iconConfig.className,
  );
  const headingClass = showWarningIndicator
    ? "font-medium text-warning"
    : showDestructiveRowStyle
      ? "font-medium text-destructive"
      : "font-medium text-foreground/82";
  const turnSettled = !activity.activeTurnInProgress;
  const showNeutralIndicator = !turnSettled && workEntryIndicatesToolNeutralStatus(workEntry);
  const showSuccessIndicator =
    workEntryIndicatesToolSuccess(workEntry) ||
    (turnSettled && workEntryIndicatesToolNeutralStatus(workEntry));
  const rowToggleProps = canExpand
    ? {
        role: "button" as const,
        tabIndex: 0 as const,
        "aria-label": displayText,
        onClick: () => setExpanded((v) => !v),
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        },
      }
    : {};

  const content = (
    <div
      className={cn(
        "flex flex-col rounded-md px-0.5 py-0.5 transition-colors",
        canExpand &&
          "cursor-pointer hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
      )}
      {...rowToggleProps}
    >
      <div className="flex select-none items-center gap-1.5 transition-[opacity,translate] duration-200">
        <span className={iconWrapperClass}>
          <WorkEntryIconSvg
            name={entryIconName}
            className="block size-3.5 shrink-0 stroke-[1.8] opacity-80"
          />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <div className="min-w-0 flex-1 overflow-hidden">
            <p className="flex min-w-0 w-full items-baseline gap-1.5 text-[12px] leading-5">
              <span className={cn("min-w-0 shrink truncate", headingClass)}>{heading}</span>
              {preview && (
                <span className="min-w-0 flex-1 truncate text-muted-foreground/55">{preview}</span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-px text-muted-foreground/55">
            <span
              className="flex size-4 shrink-0 items-center justify-center"
              aria-hidden={!canExpand}
            >
              {canExpand ? (
                <ChevronDownIcon
                  className={cn(
                    "size-3 shrink-0 opacity-70 transition-transform duration-200",
                    expanded && "rotate-180",
                  )}
                  aria-hidden
                />
              ) : null}
            </span>
            <span className="flex size-4 shrink-0 items-center justify-center">
              {showFailedIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        className="flex size-4 items-center justify-center"
                        aria-label="Tool call failed"
                      />
                    }
                  >
                    <XIcon className="block size-3 shrink-0 text-destructive" aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup>Failed</TooltipPopup>
                </Tooltip>
              ) : showSuccessIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="flex size-4 items-center justify-center" />}
                  >
                    <span className="inline-flex size-4 items-center justify-center">
                      <CheckIcon
                        className="block size-3 shrink-0 stroke-current"
                        stroke="currentColor"
                        aria-hidden
                      />
                    </span>
                  </TooltipTrigger>
                  <TooltipPopup>Completed</TooltipPopup>
                </Tooltip>
              ) : showNeutralIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="flex size-4 items-center justify-center" />}
                  >
                    <MinusIcon className="block size-3 shrink-0 opacity-70" aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup>Empty</TooltipPopup>
                </Tooltip>
              ) : null}
            </span>
            {subagentStatus ? (
              <span className="rounded border border-border/55 px-1 py-px text-[9px] uppercase tracking-[0.1em] text-muted-foreground/60">
                {subagentStatus}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      {expanded && canExpand ? (
        <div
          className="mt-1 ms-7 cursor-default border-s border-border/45 ps-3 pt-0.5"
          onClick={stopRowToggle}
          onPointerDown={stopRowToggle}
        >
          {expandedBody ? (
            <pre className="max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground select-text">
              {expandedBody}
            </pre>
          ) : null}
          {hasObservedMediaPreviews ? (
            <div
              className={cn(
                "grid gap-2",
                expandedBody && "mt-2",
                observedMediaPreviews.length === 1
                  ? "max-w-64 grid-cols-1"
                  : "max-w-md grid-cols-2",
              )}
            >
              {observedMediaPreviews.map((media) => (
                <button
                  key={media.id}
                  type="button"
                  className="group relative aspect-[4/3] overflow-hidden rounded-md border border-border/60 bg-muted/25 transition-colors hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/65"
                  title={media.name}
                  onClick={(event) => {
                    event.stopPropagation();
                    const preview = buildExpandedImagePreview(observedMediaPreviews, media.id);
                    if (preview) {
                      ctx.onImageExpand(preview);
                    }
                  }}
                  onPointerDown={stopRowToggle}
                >
                  <img
                    src={media.previewUrl}
                    alt={media.name}
                    className="size-full object-contain transition-transform duration-200 group-hover:scale-[1.015]"
                    loading="lazy"
                    draggable={false}
                  />
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  if (subagent && onOpenSubagentInspector) {
    return (
      <button
        type="button"
        className="block w-full rounded-lg px-1 py-1 text-left transition-colors duration-150 hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={() => onOpenSubagentInspector(subagent.providerThreadId)}
      >
        {content}
      </button>
    );
  }

  return <div className="rounded-lg px-1 py-1">{content}</div>;
});

function formatSubagentStatus(
  status: NonNullable<TimelineWorkEntry["subagent"]>["status"],
): string {
  switch (status) {
    case "running":
      return "Running";
    case "waiting":
      return "Waiting";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    default:
      return "Subagent";
  }
}
