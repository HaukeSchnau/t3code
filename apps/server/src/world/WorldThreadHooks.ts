import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadId, WorldThreadStatus } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * What the rest of the server asks about thread worlds (patches/worlds.md). The defaults do
 * nothing, so hosts and tests without worlds never notice.
 */
export const WorldThreadHooks = Context.Reference<{
  /** Recreates a torn-down thread world before a provider process starts in `cwd`. */
  readonly ensure: (input: {
    readonly threadId: ThreadId;
    readonly cwd: string | null;
  }) => Effect.Effect<void, string>;
  /** Whether `cwd` is a world's project or lies in one, configured or not. */
  readonly inWorld: (cwd: string) => Effect.Effect<boolean>;
  /** The state of the thread world containing `cwd`, or undefined outside worlds. */
  readonly status: (cwd: string) => Effect.Effect<WorldThreadStatus | undefined>;
  /** A turn in `cwd` ended: push the thread world's notes in the background. */
  readonly turnEnded: (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
  }) => Effect.Effect<void>;
  /** Claude's PreToolUse hook for Bash, for a session whose host cwd is `cwd`. */
  readonly claudePreToolUse: (cwd: string | null) => Effect.Effect<HookCallback | undefined>;
}>("t3/world/WorldThreadHooks", {
  defaultValue: () => ({
    ensure: () => Effect.void,
    inWorld: () => Effect.succeed(false),
    status: () => Effect.undefined,
    turnEnded: () => Effect.void,
    claudePreToolUse: () => Effect.undefined,
  }),
});
