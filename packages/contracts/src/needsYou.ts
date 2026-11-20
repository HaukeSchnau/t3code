import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** What an alert is about. */
export const NeedsYouSubjectSource = Schema.Literals([
  "run",
  "ask",
  "request",
  "guest",
  "reminder",
  "digest",
]);
export type NeedsYouSubjectSource = typeof NeedsYouSubjectSource.Type;

/** The notification setting that governs the alert. */
export const NeedsYouSubjectKind = Schema.Literals([
  "completed",
  "failed",
  "approval",
  "input",
  "digest",
]);
export type NeedsYouSubjectKind = typeof NeedsYouSubjectKind.Type;

/**
 * Something that alerts once, recorded by the server from a committed event (a run's end, an ask,
 * a request, a guest's message) or from a schedule (a reminder, the evening digest). Every client
 * presents the same subjects (patches/needs-you.md).
 */
export const NeedsYouSubject = Schema.Struct({
  /**
   * `run:<id>` (a completion; a failure adds `@<epoch ms it ended>`, since a failed run can run
   * again), `ask:<id>`, `request:<id>`, `guest:<id>`, `remind:<subject id>` or `digest:<date>`.
   */
  id: TrimmedNonEmptyString,
  /** Grows each time a subject is published or resolved, across all subjects. */
  version: NonNegativeInt,
  source: NeedsYouSubjectSource,
  kind: NeedsYouSubjectKind,
  /** The listed thread it is about: a subagent's or side chat's request is its parent's. */
  threadId: ThreadId,
  /** When it started: the run ended, the ask was raised, the reminder came due. */
  at: IsoDateTime,
  publishedAt: IsoDateTime,
  /** An ask's text, a reminder's need, or the digest's line. */
  text: Schema.optional(Schema.String),
  /** The subject it takes the place of: a `turn_end` ask replaces its run's completion. */
  replaces: Schema.optional(TrimmedNonEmptyString),
  /** The need ended before or after it was presented. */
  resolved: Schema.Boolean,
  /** A completion whose run has an ask: the ask takes its place, so it is never presented. */
  superseded: Schema.Boolean,
});
export type NeedsYouSubject = typeof NeedsYouSubject.Type;

/** The subjects published or resolved recently, oldest version first. */
export const NeedsYouSubjectsSnapshot = Schema.Struct({
  subjects: Schema.Array(NeedsYouSubject),
});
export type NeedsYouSubjectsSnapshot = typeof NeedsYouSubjectsSnapshot.Type;

export const NEEDS_YOU_WS_METHODS = {
  subscribe: "needsYou.subscribe",
} as const;

export const WsNeedsYouSubscribeRpc = Rpc.make(NEEDS_YOU_WS_METHODS.subscribe, {
  payload: Schema.Struct({}),
  success: NeedsYouSubjectsSnapshot,
  error: EnvironmentAuthorizationError,
  stream: true,
});
