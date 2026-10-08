import type { LegendListRef } from "@legendapp/list/react";
import type { ThreadFindMatch } from "@t3tools/client-runtime/thread-find";
import {
  compileThreadFind,
  findThreadMatches,
  type ThreadFindMatcher,
  type ThreadFindQuery,
} from "@t3tools/shared/threadFind";
import {
  createContext,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

import { readRenderedText, renderedTextRange } from "../../lib/assistantTextSelection";
import { cn } from "../../lib/utils";

const ENTRY_SELECTOR = "[data-find-entry]";
// Nested entries count for themselves; excerpts and chrome are not timeline text.
const NOT_SEARCHED = `${ENTRY_SELECTOR}, [data-find-skip]`;
const HIGHLIGHT = "t3-find";
const CURRENT_HIGHLIGHT = "t3-find-current";
const supportsHighlights = () => typeof CSS !== "undefined" && "highlights" in CSS;

export interface ThreadFindTimelineTarget {
  readonly entryId: string;
  readonly match: ThreadFindMatch;
  /** Changes on every navigation, so returning to the same match scrolls again. */
  readonly requestId: number;
}

export interface ThreadFindTimelineState {
  readonly query: ThreadFindQuery;
  /** Entries holding loaded `text` matches. Only these are painted. */
  readonly paintEntryIds: ReadonlySet<string>;
  readonly target: ThreadFindTimelineTarget | null;
  /** One per loaded match, oldest first. */
  readonly ticks: ReadonlyArray<{ readonly key: string; readonly entryId: string }>;
  readonly hasUnloadedMatches: boolean;
  readonly onPick: (key: string) => void;
}

interface ThreadFindReveal {
  readonly target: ThreadFindTimelineTarget | null;
  /** The entry find closed on. It stays open from then on. */
  readonly keepOpenEntryId: string | null;
}

export const ThreadFindRevealCtx = createContext<ThreadFindReveal>({
  target: null,
  keepOpenEntryId: null,
});

/**
 * Rows hiding content behind a disclosure show it while find is on them, and
 * keep it open when find closes there, so nothing moves under the reader.
 */
export function useThreadFindReveal(entryId: string) {
  const reveal = use(ThreadFindRevealCtx);
  const target = reveal.target?.entryId === entryId ? reveal.target : null;
  return {
    revealed: target !== null,
    match: target?.match ?? null,
    detail: target?.match.field === "detail" ? target.match : null,
    keepOpen: reveal.keepOpenEntryId === entryId,
  };
}

function entryRanges(
  element: HTMLElement,
  matcher: Extract<ThreadFindMatcher, { _tag: "Valid" }>,
): Range[] {
  const stream = readRenderedText(element, NOT_SEARCHED);
  return findThreadMatches(matcher, stream.text).flatMap(({ start, end }) => {
    const range = renderedTextRange(element, stream, start, end);
    return range ? [range] : [];
  });
}

function findEntryElement(viewport: HTMLElement, entryId: string): HTMLElement | null {
  return viewport.querySelector<HTMLElement>(`[data-find-entry="${CSS.escape(entryId)}"]`);
}

/**
 * Where the current match is on screen. Rendered text can differ slightly from
 * what was counted, so the occurrence is clamped, and the row stands in when
 * the text cannot be found.
 */
function targetRect(
  viewport: HTMLElement,
  target: ThreadFindTimelineTarget,
  matcher: ThreadFindMatcher | null,
): DOMRect | null {
  const element = findEntryElement(viewport, target.entryId);
  if (!element) return null;
  if (target.match.field === "text" && matcher?._tag === "Valid") {
    const ranges = entryRanges(element, matcher);
    const rect =
      ranges[Math.min(target.match.occurrence, ranges.length - 1)]?.getBoundingClientRect();
    if (rect && rect.height > 0) return rect;
  }
  // Detail, and text a row does not render, show in an excerpt under the row.
  return (
    element.querySelector("[data-find-current]")?.getBoundingClientRect() ??
    element.getBoundingClientRect()
  );
}

const holdsEntry = (node: Node) =>
  node instanceof Element && (node.matches(ENTRY_SELECTOR) || node.querySelector(ENTRY_SELECTOR));

/**
 * Paints every match in mounted rows, and repaints as rows mount or stream.
 * Ranges are kept per entry element, and a mutation re-walks only the entry it
 * touched, so a streaming message does not re-walk every mounted row.
 */
export function useThreadFindPainter(
  viewport: HTMLElement | null,
  find: ThreadFindTimelineState | null,
) {
  const query = find?.query;
  const paintEntryIds = find?.paintEntryIds;
  const target = find?.target ?? null;
  useEffect(() => {
    if (!supportsHighlights() || !viewport || !query || !paintEntryIds) return;
    const matcher = compileThreadFind(query);
    if (matcher?._tag !== "Valid") return;
    const rangesByElement = new Map<HTMLElement, Range[]>();
    const dirty = new Set<HTMLElement>();
    let rescan = true;
    let frame = 0;
    const paint = () => {
      frame = 0;
      if (rescan) {
        rescan = false;
        const mounted = new Set<HTMLElement>();
        for (const element of viewport.querySelectorAll<HTMLElement>(ENTRY_SELECTOR)) {
          if (!paintEntryIds.has(element.dataset.findEntry ?? "")) continue;
          mounted.add(element);
          if (!rangesByElement.has(element)) dirty.add(element);
        }
        for (const element of rangesByElement.keys()) {
          if (!mounted.has(element)) rangesByElement.delete(element);
        }
      }
      for (const element of dirty) {
        if (element.isConnected && paintEntryIds.has(element.dataset.findEntry ?? "")) {
          rangesByElement.set(element, entryRanges(element, matcher));
        } else {
          rangesByElement.delete(element);
        }
      }
      dirty.clear();
      const all = new Highlight();
      let current: Range | null = null;
      for (const [element, ranges] of rangesByElement) {
        for (const range of ranges) all.add(range);
        if (
          target !== null &&
          target.entryId === element.dataset.findEntry &&
          target.match.field === "text"
        ) {
          current = ranges[Math.min(target.match.occurrence, ranges.length - 1)] ?? null;
        }
      }
      CSS.highlights.set(HIGHLIGHT, all);
      if (current) {
        const highlight = new Highlight(current);
        highlight.priority = 1;
        CSS.highlights.set(CURRENT_HIGHLIGHT, highlight);
      } else {
        CSS.highlights.delete(CURRENT_HIGHLIGHT);
      }
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(paint);
    };
    schedule();
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const node = record.target;
        const entry =
          (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
            ENTRY_SELECTOR,
          ) ?? null;
        if (entry !== null) dirty.add(entry);
        // Rendered text skips hidden subtrees, so their flips change an entry's text.
        if (record.type === "attributes" && record.attributeName !== "data-find-entry") continue;
        if (
          entry === null ||
          record.type === "attributes" ||
          [...record.addedNodes, ...record.removedNodes].some(holdsEntry)
        ) {
          rescan = true;
        }
      }
      schedule();
    });
    observer.observe(viewport, {
      childList: true,
      subtree: true,
      characterData: true,
      attributeFilter: ["data-find-entry", "hidden", "aria-hidden"],
    });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      CSS.highlights.delete(HIGHLIGHT);
      CSS.highlights.delete(CURRENT_HIGHLIGHT);
    };
  }, [viewport, query, paintEntryIds, target]);
}

function flashRect(container: HTMLElement, rect: DOMRect) {
  const box = container.getBoundingClientRect();
  const flash = container.ownerDocument.createElement("div");
  flash.className = "thread-find-flash";
  flash.setAttribute("aria-hidden", "true");
  Object.assign(flash.style, {
    left: `${rect.left - box.left - 2}px`,
    top: `${rect.top - box.top - 1}px`,
    width: `${rect.width + 4}px`,
    height: `${rect.height + 2}px`,
  });
  container.appendChild(flash);
  flash.addEventListener("animationend", () => flash.remove(), { once: true });
}

/**
 * Brings the current match into view: mounts its row if needed, then scrolls
 * so the match sits about a third down the viewport, unless it is already in
 * comfortable view. Returns the row key to keep mounted meanwhile.
 */
export function useThreadFindNavigation(input: {
  readonly target: ThreadFindTimelineTarget | null;
  readonly query: ThreadFindQuery | null;
  readonly targetRow: { readonly index: number; readonly key: string } | null;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly container: HTMLElement | null;
  readonly onManualNavigation: () => void;
}): string | null {
  const { target, query, targetRow, listRef, container, onManualNavigation } = input;
  const [pinnedRowKey, setPinnedRowKey] = useState<string | null>(null);
  const handledRequestRef = useRef<number | null>(null);
  const rowReady = targetRow !== null;
  // Read through refs so streaming row churn neither restarts nor cancels a jump.
  const latest = useRef({ query, targetRow, container, onManualNavigation });
  useLayoutEffect(() => {
    latest.current = { query, targetRow, container, onManualNavigation };
  });

  useLayoutEffect(() => {
    const list = listRef.current;
    const viewport = list?.getScrollableNode();
    const row = latest.current.targetRow;
    if (!target || !rowReady || !list || !viewport || !row) return;
    if (handledRequestRef.current === target.requestId) return;
    handledRequestRef.current = target.requestId;
    latest.current.onManualNavigation();
    setPinnedRowKey(row.key);
    const matcher = latest.current.query ? compileThreadFind(latest.current.query) : null;
    let cancelled = false;
    let done = false;
    let frame = 0;
    let attempts = 0;
    let scrolledToRow = false;

    const finish = () => {
      done = true;
      const rect = targetRect(viewport, target, matcher);
      if (rect && latest.current.container) flashRect(latest.current.container, rect);
      setPinnedRowKey(null);
    };
    const settle = () => {
      if (cancelled) return;
      const rect = targetRect(viewport, target, matcher);
      if (rect === null) {
        if (!scrolledToRow) {
          scrolledToRow = true;
          void Promise.resolve(
            list.scrollToIndex({ index: row.index, animated: false, viewPosition: 0.35 }),
          ).then(() => {
            if (!cancelled) frame = requestAnimationFrame(settle);
          });
          return;
        }
        if (++attempts > 40) {
          done = true;
          setPinnedRowKey(null);
          return;
        }
        frame = requestAnimationFrame(settle);
        return;
      }
      const box = viewport.getBoundingClientRect();
      const relative = rect.top - box.top;
      if (relative >= box.height * 0.12 && relative + rect.height <= box.height * 0.82) {
        finish();
        return;
      }
      const offset = Math.max(0, viewport.scrollTop + relative - box.height * 0.35);
      const animated = Math.abs(offset - viewport.scrollTop) < box.height;
      void Promise.resolve(list.scrollToOffset({ offset, animated })).then(() => {
        if (!cancelled) frame = requestAnimationFrame(finish);
      });
    };
    frame = requestAnimationFrame(settle);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      // An interrupted jump releases its row, and runs again if its target returns.
      if (!done) {
        handledRequestRef.current = null;
        setPinnedRowKey(null);
      }
    };
  }, [listRef, rowReady, target]);

  return pinnedRowKey;
}

/** Marks where matches sit along the scrollbar. Clicking one jumps to it. */
export function ThreadFindTicks(props: {
  readonly find: ThreadFindTimelineState;
  readonly rowIndexByEntryId: ReadonlyMap<string, number>;
  readonly listRef: RefObject<LegendListRef | null>;
}) {
  const { find, rowIndexByEntryId, listRef } = props;
  const [ticks, setTicks] = useState<ReadonlyArray<{ key: string; top: number; current: boolean }>>(
    [],
  );
  useLayoutEffect(() => {
    const list = listRef.current;
    const viewport = list?.getScrollableNode();
    if (!list || !viewport) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const state = list.getState();
      const contentLength = Math.max(1, state.contentLength);
      const byTop = new Map<number, { key: string; top: number; current: boolean }>();
      let lastRowIndex = 0;
      for (const tick of find.ticks) {
        // Matches hidden in a fold take the position of the row before them.
        const rowIndex = rowIndexByEntryId.get(tick.entryId) ?? lastRowIndex;
        lastRowIndex = rowIndex;
        const position = state.positionAtIndex(rowIndex);
        if (!Number.isFinite(position)) continue;
        const top = Math.round((position / contentLength) * 1000) / 10;
        const current = find.target?.match.key === tick.key;
        if (!byTop.has(top) || current) byTop.set(top, { key: tick.key, top, current });
      }
      const next = [...byTop.values()];
      // Measured on every scroll frame; most frames move nothing.
      setTicks((previous) =>
        previous.length === next.length &&
        previous.every(
          (tick, index) =>
            tick.key === next[index]!.key &&
            tick.top === next[index]!.top &&
            tick.current === next[index]!.current,
        )
          ? previous
          : next,
      );
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    schedule();
    viewport.addEventListener("scroll", schedule, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("scroll", schedule);
    };
  }, [find.target, find.ticks, listRef, rowIndexByEntryId]);

  return (
    <div className="pointer-events-none absolute inset-y-2 right-0.5 z-20 w-2" aria-hidden="true">
      {find.hasUnloadedMatches ? (
        <span className="absolute -top-1.5 right-0 text-4xs leading-none text-warning">▲</span>
      ) : null}
      {ticks.map((tick) => (
        <button
          key={tick.key}
          type="button"
          tabIndex={-1}
          className={cn(
            "pointer-events-auto absolute right-0 h-0.75 w-2 rounded-xs bg-warning/80",
            tick.current && "thread-find-tick-current z-10 h-1 w-2.5",
          )}
          style={{ top: `${tick.top}%` }}
          onClick={() => find.onPick(tick.key)}
        />
      ))}
    </div>
  );
}

function formatSize(length: number): string {
  return length >= 1024 * 1024
    ? `${(length / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.round(length / 1024)} KB`;
}

/** Content the client never received, shown under its row while find is on it. */
export function ThreadFindExcerpt(props: {
  readonly match: ThreadFindMatch;
  readonly label: string;
}) {
  const { excerpt } = props.match;
  return (
    <div
      data-find-skip
      className="mt-1 overflow-hidden rounded-md border border-warning/40 bg-muted/40"
    >
      <div className="border-b border-border/60 px-2.5 py-1 text-2xs text-warning">
        {props.label}, line {excerpt.line}.{" "}
        {excerpt.totalLength === undefined
          ? "Shown while find is here."
          : `Only the first 256 KB of ${formatSize(excerpt.totalLength)} is searchable.`}
      </div>
      <pre className="overflow-x-auto px-2.5 py-1.5 font-mono text-xs leading-relaxed whitespace-pre">
        {excerpt.text.slice(0, excerpt.start)}
        <mark data-find-current className="thread-find-current-mark">
          {excerpt.text.slice(excerpt.start, excerpt.end)}
        </mark>
        {excerpt.text.slice(excerpt.end)}
      </pre>
    </div>
  );
}
