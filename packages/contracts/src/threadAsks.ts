import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  RunId,
  ThreadAskId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * An ask is something an agent needs from the user. It stays open until the user acts: a reply,
 * No reply needed, or the agent withdrawing it. Opening the thread never ends one.
 */
export const THREAD_ASK_TEXT_MAX_LENGTH = 120;
/** Entries a thread keeps. Open asks are always kept; the oldest resolved ones go first. */
export const THREAD_ASK_LIMIT = 20;

export const ThreadAskSource = Schema.Union([
  /** A turn of a top-level thread ended waiting on the user. */
  Schema.Struct({ type: Schema.Literal("turn_end"), runId: RunId }),
  /**
   * A page (`html_render`) asks the reader for input. `renderId` is its first version's id;
   * `runId` is the run that last set the ask, whose ending needs no ask of its own.
   */
  Schema.Struct({
    type: Schema.Literal("page"),
    renderId: TrimmedNonEmptyString,
    runId: Schema.optional(RunId),
  }),
]);
export type ThreadAskSource = typeof ThreadAskSource.Type;

export const ThreadAskStatus = Schema.Literals([
  "open",
  "answered",
  "dismissed",
  "withdrawn",
  "replaced",
]);
export type ThreadAskStatus = typeof ThreadAskStatus.Type;

/** One line for the user, phrased as what they must decide or do. */
export const ThreadAskText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(THREAD_ASK_TEXT_MAX_LENGTH),
);

export const ThreadAsk = Schema.Struct({
  id: ThreadAskId,
  source: ThreadAskSource,
  text: TrimmedNonEmptyString,
  raisedAt: IsoDateTime,
  status: ThreadAskStatus,
  resolvedAt: Schema.optional(IsoDateTime),
  /** The user message that answered it, so cancelling that queued message reopens the ask. */
  answeredBy: Schema.optional(MessageId),
});
export type ThreadAsk = typeof ThreadAsk.Type;

/** An open ask as thread lists see it. */
export const ThreadOpenAsk = ThreadAsk.mapFields(({ id, source, text, raisedAt }) => ({
  id,
  source,
  text,
  raisedAt,
}));
export type ThreadOpenAsk = typeof ThreadOpenAsk.Type;

/** The thread's open asks, oldest first, for its shell. */
export const threadOpenAsks = (
  asks: ReadonlyArray<ThreadAsk> | null | undefined,
): ReadonlyArray<ThreadOpenAsk> =>
  (asks ?? []).flatMap((ask) =>
    ask.status === "open"
      ? [{ id: ask.id, source: ask.source, text: ask.text, raisedAt: ask.raisedAt }]
      : [],
  );

/**
 * The run whose ending an ask stands in for, so that ending needs no ask and no Done of its own:
 * a turn-end ask's run in any status, or the run that last set a page's ask unless the agent
 * withdrew it (an answered or dismissed page ask still covers it).
 */
export const askedRunId = (ask: Pick<ThreadAsk, "source" | "status">): RunId | undefined =>
  ask.source.type === "turn_end"
    ? ask.source.runId
    : ask.status === "withdrawn"
      ? undefined
      : ask.source.runId;
