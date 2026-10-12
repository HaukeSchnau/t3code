import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * `mixed`: two turns edited a file before it was sealed, so the change holds
 * both. `swept`: an agent committed files another turn had edited.
 */
export const JjChangeFlag = Schema.Literals(["mixed", "swept"]);
export type JjChangeFlag = typeof JjChangeFlag.Type;

export const JjStackEntry = Schema.Struct({
  changeId: TrimmedNonEmptyString,
  commitId: TrimmedNonEmptyString,
  /** First line of the description; empty when undescribed. */
  description: Schema.String,
  empty: Schema.Boolean,
  conflict: Schema.Boolean,
  workingCopy: Schema.Boolean,
  bookmarks: Schema.Array(TrimmedNonEmptyString),
  /** Every bookmark on the change matches its remote. */
  pushed: Schema.Boolean,
  /** From the change's `T3-Thread` trailer. */
  threadId: Schema.NullOr(TrimmedNonEmptyString),
  /** From the change's `T3-Turn` trailers, one per turn that described it. */
  turns: Schema.Array(PositiveInt),
  flags: Schema.Array(JjChangeFlag),
});
export type JjStackEntry = typeof JjStackEntry.Type;

export const JjStatus = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  /** The change the stack starts from, labelled like `main@origin`. */
  trunk: Schema.NullOr(
    Schema.Struct({ changeId: TrimmedNonEmptyString, label: TrimmedNonEmptyString }),
  ),
  /** `trunk()..@`, newest first, so the working-copy change comes first. */
  stack: Schema.Array(JjStackEntry),
  conflictedFiles: Schema.Array(TrimmedNonEmptyString),
  /** Files changed in `@` that no running or finished turn could claim. */
  unattributed: Schema.Array(TrimmedNonEmptyString),
});
export type JjStatus = typeof JjStatus.Type;

const ChangeTarget = { changeId: TrimmedNonEmptyString };

export const JjAction = Schema.Union([
  /** Without a message, T3's commit writer describes the change. */
  Schema.TaggedStruct("describe", { ...ChangeTarget, message: Schema.optional(Schema.String) }),
  /** Commits `@`, or only `paths` from it, and starts a new change. */
  Schema.TaggedStruct("commit", {
    message: Schema.optional(Schema.String),
    paths: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  }),
  /** Starts a new change on `base` (a change id), or on `@`. */
  Schema.TaggedStruct("new", { base: Schema.optional(TrimmedNonEmptyString) }),
  Schema.TaggedStruct("squash", ChangeTarget),
  Schema.TaggedStruct("abandon", ChangeTarget),
  Schema.TaggedStruct("split", {
    ...ChangeTarget,
    paths: Schema.Array(TrimmedNonEmptyString),
    message: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("absorb", {}),
  Schema.TaggedStruct("edit", ChangeTarget),
  Schema.TaggedStruct("bookmark", {
    operation: Schema.Literals(["set", "rename", "delete"]),
    name: TrimmedNonEmptyString,
    changeId: Schema.optional(TrimmedNonEmptyString),
    newName: Schema.optional(TrimmedNonEmptyString),
  }),
  /** Pushes the change's bookmark, creating `t3code/<slug>` when it has none. */
  Schema.TaggedStruct("push", { changeId: Schema.optional(TrimmedNonEmptyString) }),
  Schema.TaggedStruct("pr", { changeId: Schema.optional(TrimmedNonEmptyString) }),
  Schema.TaggedStruct("fetch", {}),
  /** Rebases the stack onto `trunk()`. */
  Schema.TaggedStruct("rebase", {}),
  /** Reverts an operation T3 ran; the latest one without an id. */
  Schema.TaggedStruct("undo", { operationId: Schema.optional(TrimmedNonEmptyString) }),
]);
export type JjAction = typeof JjAction.Type;
export type JjActionType = JjAction["_tag"];

export const JjRunActionInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  action: JjAction,
  threadId: Schema.optional(ThreadId),
});
export type JjRunActionInput = typeof JjRunActionInput.Type;

export const JjRunActionResult = Schema.Struct({
  /** The jj operation the action recorded, for undo. */
  operationId: Schema.NullOr(TrimmedNonEmptyString),
  summary: Schema.String,
  /** Changes in the stack that hold conflicts after the action. */
  conflictedChanges: Schema.Array(TrimmedNonEmptyString),
  pullRequestUrl: Schema.optional(Schema.String),
});
export type JjRunActionResult = typeof JjRunActionResult.Type;

export class JjActionError extends Schema.TaggedError<JjActionError>()("JjActionError", {
  action: Schema.String,
  cwd: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

/** Claims unattributed files in `@` for a thread, so its next seal takes them. */
export const JjAssignPathsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  paths: Schema.Array(TrimmedNonEmptyString),
  threadId: ThreadId,
});
export type JjAssignPathsInput = typeof JjAssignPathsInput.Type;

export const JjAssignPathsResult = Schema.Struct({ assigned: NonNegativeInt });
export type JjAssignPathsResult = typeof JjAssignPathsResult.Type;

/** The trailer keys T3 writes into commit descriptions. */
export const JJ_THREAD_TRAILER = "T3-Thread";
export const JJ_TURN_TRAILER = "T3-Turn";

export const JjThreadWorkChange = Schema.Struct({
  changeId: TrimmedNonEmptyString,
  description: Schema.String,
  turns: Schema.Array(PositiveInt),
  pushed: Schema.Boolean,
  empty: Schema.Boolean,
});
export type JjThreadWorkChange = typeof JjThreadWorkChange.Type;

/** One repository where a thread left changes or ran jj operations. */
export const JjThreadWorkRepository = Schema.Struct({
  root: TrimmedNonEmptyString,
  changes: Schema.Array(JjThreadWorkChange),
  /** jj operations tagged with the thread, among the repository's recent ones. */
  taggedOperations: NonNegativeInt,
});
export type JjThreadWorkRepository = typeof JjThreadWorkRepository.Type;

export const JjThreadWorkInput = Schema.Struct({ threadId: ThreadId });
export type JjThreadWorkInput = typeof JjThreadWorkInput.Type;

export const JjThreadWorkResult = Schema.Struct({
  repositories: Schema.Array(JjThreadWorkRepository),
});
export type JjThreadWorkResult = typeof JjThreadWorkResult.Type;
