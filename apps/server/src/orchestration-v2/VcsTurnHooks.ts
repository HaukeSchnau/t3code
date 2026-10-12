import type { CheckpointRef, RunId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class VcsTurnHookError extends Schema.TaggedError<VcsTurnHookError>()("VcsTurnHookError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * VCS work at turn boundaries that the checkpoint ref alone cannot do. jj
 * working copies seal each turn into its own change and revert per thread;
 * everything else keeps the defaults, which do nothing.
 */
export class VcsTurnHooks extends Context.Reference<{
  readonly turnStarted: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly ordinal: number;
    readonly cwd: string;
  }) => Effect.Effect<void>;
  /** Runs before the turn's checkpoint is captured, whatever the run's outcome. */
  readonly sealTurn: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly ordinal: number;
    readonly cwd: string;
    readonly failed: boolean;
  }) => Effect.Effect<void>;
  /** Whether file restore for `cwd` is thread-scoped, so a shared checkout is allowed. */
  readonly ownsFileRevert: (cwd: string) => Effect.Effect<boolean>;
  /**
   * Runs before the provider rewinds, so a revert that cannot restore files
   * fails while the conversation is intact: checks the checkpoint, then waits
   * until other threads' turns in `cwd` are idle.
   */
  readonly prepareFileRevert: (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly checkpointRef: CheckpointRef;
  }) => Effect.Effect<void, VcsTurnHookError>;
  readonly revertFiles: (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly checkpointRef: CheckpointRef;
  }) => Effect.Effect<void, VcsTurnHookError>;
  /** A workspace of its own for a new fork, or null to share the source's directory. */
  readonly prepareForkWorkspace: (input: {
    readonly sourceThreadId: ThreadId;
    readonly targetThreadId: ThreadId;
    readonly title: string;
  }) => Effect.Effect<string | null>;
  /** Moves a fork's file changes into its parent's working copy. */
  readonly mergeBackFiles: (input: {
    readonly sourceThreadId: ThreadId;
    readonly targetThreadId: ThreadId;
  }) => Effect.Effect<void, VcsTurnHookError>;
}>("t3/orchestration-v2/VcsTurnHooks", {
  defaultValue: () => ({
    turnStarted: () => Effect.void,
    sealTurn: () => Effect.void,
    ownsFileRevert: () => Effect.succeed(false),
    prepareFileRevert: () => Effect.void,
    revertFiles: () => Effect.void,
    prepareForkWorkspace: () => Effect.succeed(null),
    mergeBackFiles: () => Effect.void,
  }),
}) {}
