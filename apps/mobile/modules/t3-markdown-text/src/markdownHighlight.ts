import { parseComposerContextHref } from "@t3tools/shared/composerContextReferences";

import type { NativeMarkdownTextRun } from "./nativeMarkdownText";

export interface MarkdownHighlightRange {
  readonly start: number;
  readonly end: number;
}

export type MarkdownHighlightMark = "match" | "current";

export interface MarkdownTextHighlight {
  /** The ranges to mark in one piece of rendered text, in order and non-overlapping. */
  readonly find: (text: string) => ReadonlyArray<MarkdownHighlightRange>;
  /** The emphasized range, counted in reading order across everything this highlight covers; -1 for none. */
  readonly current: number;
  readonly color: string;
  readonly currentColor: string;
}

export interface MarkdownHighlightSegment {
  readonly text: string;
  readonly mark: MarkdownHighlightMark | null;
}

// Layout runs a reader does not read as content. They keep their length so
// offsets stay aligned with the runs, but never match a query.
const LAYOUT_ROLES = new Set<NativeMarkdownTextRun["role"]>([
  "list-marker",
  "quote-marker",
  "divider",
  "code-language",
  "spacer",
]);

export function markdownRunsSearchText(runs: ReadonlyArray<NativeMarkdownTextRun>): string {
  return runs
    .map((run) => (LAYOUT_ROLES.has(run.role) ? "\n".repeat(run.text.length) : run.text))
    .join("");
}

export function markdownRunsHighlightCount(
  runs: ReadonlyArray<NativeMarkdownTextRun>,
  find: MarkdownTextHighlight["find"],
): number {
  return find(markdownRunsSearchText(runs)).length;
}

// Chips draw their label as an image, so a split would draw two chips.
function isChipRun(run: NativeMarkdownTextRun): boolean {
  return (
    run.fileIcon != null ||
    run.skillName != null ||
    parseComposerContextHref(run.href ?? "") !== null
  );
}

/** Splits runs at range boundaries and marks the pieces inside a range. */
export function highlightMarkdownRuns(
  runs: ReadonlyArray<NativeMarkdownTextRun>,
  ranges: ReadonlyArray<MarkdownHighlightRange>,
  current: number,
): ReadonlyArray<NativeMarkdownTextRun> {
  const highlighted: NativeMarkdownTextRun[] = [];
  let rangeIndex = 0;
  let offset = 0;
  for (const run of runs) {
    const start = offset;
    const end = start + run.text.length;
    offset = end;
    while (rangeIndex < ranges.length && ranges[rangeIndex]!.end <= start) rangeIndex += 1;
    if (
      rangeIndex >= ranges.length ||
      ranges[rangeIndex]!.start >= end ||
      isChipRun(run) ||
      LAYOUT_ROLES.has(run.role)
    ) {
      highlighted.push(run);
      continue;
    }
    let cursor = start;
    for (let index = rangeIndex; index < ranges.length && ranges[index]!.start < end; index += 1) {
      const from = Math.max(ranges[index]!.start, start);
      const to = Math.min(ranges[index]!.end, end);
      if (from > cursor)
        highlighted.push({ ...run, text: run.text.slice(cursor - start, from - start) });
      highlighted.push({
        ...run,
        text: run.text.slice(from - start, to - start),
        highlight: index === current ? "current" : "match",
      });
      cursor = to;
    }
    if (cursor < end) highlighted.push({ ...run, text: run.text.slice(cursor - start) });
  }
  return highlighted;
}

/** Plain text cut at range boundaries, for renderers that draw their own spans. */
export function splitMarkdownHighlight(
  text: string,
  ranges: ReadonlyArray<MarkdownHighlightRange>,
  current: number,
): ReadonlyArray<MarkdownHighlightSegment> {
  const segments: MarkdownHighlightSegment[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    const start = Math.max(range.start, cursor);
    const end = Math.min(range.end, text.length);
    if (end <= start) return;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), mark: null });
    segments.push({ text: text.slice(start, end), mark: index === current ? "current" : "match" });
    cursor = end;
  });
  if (cursor < text.length) segments.push({ text: text.slice(cursor), mark: null });
  return segments;
}

/**
 * Hands each part the highlight with `current` counted from that part's own
 * first range. With `clampToLast`, a `current` past the end marks the last
 * range: callers whose counts come from a different reading of the same text
 * still land on a nearby occurrence.
 */
export function distributeMarkdownHighlight<Part>(
  highlight: MarkdownTextHighlight | undefined,
  parts: ReadonlyArray<Part>,
  count: (part: Part) => number,
  options: { readonly clampToLast?: boolean } = {},
): ReadonlyArray<MarkdownTextHighlight | undefined> {
  if (highlight === undefined) return parts.map(() => undefined);
  if (highlight.current < 0) return parts.map(() => highlight);
  const counts = parts.map(count);
  const total = counts.reduce((sum, value) => sum + value, 0);
  const target = options.clampToLast ? Math.min(highlight.current, total - 1) : highlight.current;
  const none: MarkdownTextHighlight = { ...highlight, current: -1 };
  let before = 0;
  return counts.map((value) => {
    const local = target - before;
    before += value;
    return local >= 0 && local < value ? { ...highlight, current: local } : none;
  });
}
