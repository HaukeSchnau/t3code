import * as Schema from "effect/Schema";

import {
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";

export const OrchestrationThreadFindSource = Schema.Literals([
  "user",
  "assistant",
  "reasoning",
  "tool",
]);
export type OrchestrationThreadFindSource = typeof OrchestrationThreadFindSource.Type;

/**
 * `text` is what clients render for a timeline item. `detail` is content the
 * wire projection strips, such as command output and diffs, so only the
 * server can find it.
 */
export const OrchestrationThreadFindField = Schema.Literals(["text", "detail"]);
export type OrchestrationThreadFindField = typeof OrchestrationThreadFindField.Type;

// The server's SQLite client is synchronous and single-connection. A find scans
// one thread in pages and stops at a match limit and a payload byte budget.
// There is no regex option: a pathological pattern would stall the server's
// event loop, so clients match regex queries only against what they loaded.
export const OrchestrationFindInThreadInput = Schema.Struct({
  threadId: ThreadId,
  query: Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(200)),
  caseSensitive: Schema.optionalKey(Schema.Boolean),
  wholeWord: Schema.optionalKey(Schema.Boolean),
});
export type OrchestrationFindInThreadInput = typeof OrchestrationFindInThreadInput.Type;

/** The lines around a match. `start` and `end` index into `text`. */
export const OrchestrationThreadFindExcerpt = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(1000)),
  start: NonNegativeInt,
  end: NonNegativeInt,
  line: PositiveInt,
  /** Length of the whole field when only a prefix of it was searched. */
  totalLength: Schema.optionalKey(PositiveInt),
});
export type OrchestrationThreadFindExcerpt = typeof OrchestrationThreadFindExcerpt.Type;

export const OrchestrationThreadFindMatch = Schema.Struct({
  /** Rows in the thread's visible timeline, including rows inherited from a fork source. */
  sourceThreadId: ThreadId,
  sourceItemId: TurnItemId,
  /** Index in the visible timeline, oldest first. */
  position: NonNegativeInt,
  source: OrchestrationThreadFindSource,
  field: OrchestrationThreadFindField,
  /** The nth match inside this item's field, counted by the shared matcher. */
  occurrence: NonNegativeInt,
  excerpt: OrchestrationThreadFindExcerpt,
});
export type OrchestrationThreadFindMatch = typeof OrchestrationThreadFindMatch.Type;

export const OrchestrationFindInThreadResult = Schema.Struct({
  matches: Schema.Array(OrchestrationThreadFindMatch),
  /** The scan stopped at the match limit or the payload byte budget. */
  truncated: Schema.Boolean,
});
export type OrchestrationFindInThreadResult = typeof OrchestrationFindInThreadResult.Type;

export class OrchestrationFindInThreadError extends Schema.TaggedError<OrchestrationFindInThreadError>()(
  "OrchestrationFindInThreadError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
