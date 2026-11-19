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
  /** Set once, when the user was reminded of the still-open ask. */
  remindedAt: Schema.optional(IsoDateTime),
});
export type ThreadAsk = typeof ThreadAsk.Type;

/** An open ask as thread lists see it. */
export const ThreadOpenAsk = ThreadAsk.mapFields(({ id, source, text, raisedAt, remindedAt }) => ({
  id,
  source,
  text,
  raisedAt,
  remindedAt,
}));
export type ThreadOpenAsk = typeof ThreadOpenAsk.Type;

/** The thread's open asks, oldest first, for its shell. */
export const threadOpenAsks = (
  asks: ReadonlyArray<ThreadAsk> | null | undefined,
): ReadonlyArray<ThreadOpenAsk> =>
  (asks ?? []).flatMap((ask) =>
    ask.status === "open"
      ? [
          {
            id: ask.id,
            source: ask.source,
            text: ask.text,
            raisedAt: ask.raisedAt,
            ...(ask.remindedAt === undefined ? {} : { remindedAt: ask.remindedAt }),
          },
        ]
      : [],
  );
