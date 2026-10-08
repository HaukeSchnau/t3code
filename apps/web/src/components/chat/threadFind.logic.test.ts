import type { ThreadFindMatch } from "@t3tools/client-runtime/thread-find";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "../../session-logic";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  buildThreadFindEntryIndex,
  isAtOrAboveOrigin,
  threadFindRowIndexByEntryId,
  threadFindSnippet,
} from "./threadFind.logic";

const entries = [
  {
    id: "message-1",
    kind: "message",
    createdAt: "2026-10-08T00:00:00Z",
    message: { id: "message-1", role: "user", text: "probe it" },
    projectedItem: { sourceItemId: "item-user" },
  },
  {
    id: "item-cmd",
    kind: "work",
    createdAt: "2026-10-08T00:00:01Z",
    entry: { id: "item-cmd", projectedItem: { sourceItemId: "item-cmd" } },
  },
  { id: "item-plan", kind: "proposed-plan", createdAt: "2026-10-08T00:00:02Z" },
] as unknown as ReadonlyArray<TimelineEntry>;

const match = (sourceItemId: string, loaded = true) =>
  ({ sourceItemId, loaded }) as unknown as ThreadFindMatch;

describe("buildThreadFindEntryIndex", () => {
  it("maps turn items to the entries that render them, in order", () => {
    const index = buildThreadFindEntryIndex(entries);
    expect([...index.entryIdByItemId]).toEqual([
      ["item-user", "message-1"],
      ["item-cmd", "item-cmd"],
      ["item-plan", "item-plan"],
    ]);
    expect(index.orderByEntryId.get("item-plan")).toBe(2);
  });

  it("treats unloaded history as above the origin and later entries as below", () => {
    const index = buildThreadFindEntryIndex(entries);
    expect(isAtOrAboveOrigin(match("unknown", false), index, 0)).toBe(true);
    expect(isAtOrAboveOrigin(match("item-user"), index, 1)).toBe(true);
    expect(isAtOrAboveOrigin(match("item-plan"), index, 1)).toBe(false);
  });
});

describe("threadFindRowIndexByEntryId", () => {
  it("prefers an expanded group's details row over its summary", () => {
    const rows = [
      { kind: "message", id: "message-1", message: { id: "message-1" } },
      { kind: "work-live", id: "live", groupedEntries: [{ id: "item-cmd" }] },
      { kind: "work", id: "group:details", groupedEntries: [{ id: "item-cmd" }] },
      { kind: "proposed-plan", id: "item-plan" },
    ] as unknown as ReadonlyArray<MessagesTimelineRow>;
    expect([...threadFindRowIndexByEntryId(rows)]).toEqual([
      ["message-1", 0],
      ["item-cmd", 2],
      ["item-plan", 3],
    ]);
  });
});

describe("threadFindSnippet", () => {
  it("keeps only the line holding the match", () => {
    const text = "first line\n  second probe line  \nthird";
    const start = text.indexOf("probe");
    expect(threadFindSnippet({ text, start, end: start + 5, line: 2 })).toEqual({
      before: "second ",
      match: "probe",
      after: " line",
    });
  });
});
