import type { ThreadFindMatch } from "@t3tools/client-runtime/thread-find";
import type { OrchestrationThreadFindExcerpt } from "@t3tools/contracts";

import type { TimelineEntry } from "../../session-logic";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

function entryItemId(entry: TimelineEntry): string | undefined {
  switch (entry.kind) {
    case "message":
      return entry.projectedItem?.sourceItemId;
    case "work":
      return entry.entry.projectedItem?.sourceItemId;
    case "event":
      return entry.projectedItem.sourceItemId;
    case "proposed-plan":
      // Plan entries are keyed by their turn item id.
      return entry.id;
  }
}

/** Where each turn item renders: its timeline entry and that entry's order. */
export interface ThreadFindEntryIndex {
  readonly entryIdByItemId: ReadonlyMap<string, string>;
  readonly orderByEntryId: ReadonlyMap<string, number>;
}

export function buildThreadFindEntryIndex(
  entries: ReadonlyArray<TimelineEntry>,
): ThreadFindEntryIndex {
  const entryIdByItemId = new Map<string, string>();
  const orderByEntryId = new Map<string, number>();
  entries.forEach((entry, order) => {
    orderByEntryId.set(entry.id, order);
    const itemId = entryItemId(entry);
    if (itemId !== undefined) entryIdByItemId.set(itemId, entry.id);
  });
  return { entryIdByItemId, orderByEntryId };
}

/**
 * Whether a match sits at or above the bottom of where the reader was. Rows
 * the client has not loaded are above everything loaded.
 */
export function isAtOrAboveOrigin(
  match: ThreadFindMatch,
  index: ThreadFindEntryIndex,
  originOrder: number,
): boolean {
  if (!match.loaded) return true;
  const entryId = index.entryIdByItemId.get(match.sourceItemId);
  const order = entryId === undefined ? undefined : index.orderByEntryId.get(entryId);
  return order === undefined || order <= originOrder;
}

/** The excerpt line holding the match, split for highlighting. */
export function threadFindSnippet(excerpt: OrchestrationThreadFindExcerpt) {
  const lineStart = excerpt.start === 0 ? 0 : excerpt.text.lastIndexOf("\n", excerpt.start - 1) + 1;
  const lineEndIndex = excerpt.text.indexOf("\n", excerpt.end);
  const lineEnd = lineEndIndex === -1 ? excerpt.text.length : lineEndIndex;
  return {
    before: excerpt.text.slice(lineStart, excerpt.start).trimStart(),
    match: excerpt.text.slice(excerpt.start, excerpt.end),
    after: excerpt.text.slice(excerpt.end, lineEnd).trimEnd(),
  };
}

/**
 * Which row shows each entry. An expanded work group lists its entries in its
 * details row, which comes after the summary and wins. Entries hidden in a
 * fold have no row.
 */
export function threadFindRowIndexByEntryId(
  rows: ReadonlyArray<MessagesTimelineRow>,
): ReadonlyMap<string, number> {
  const indexByEntryId = new Map<string, number>();
  rows.forEach((row, index) => {
    switch (row.kind) {
      case "message":
        indexByEntryId.set(row.message.id, index);
        break;
      case "work":
      case "work-live":
        for (const entry of row.groupedEntries) indexByEntryId.set(entry.id, index);
        break;
      case "proposed-plan":
      case "event":
        indexByEntryId.set(row.id, index);
        break;
    }
  });
  return indexByEntryId;
}
