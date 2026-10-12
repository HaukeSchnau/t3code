import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * Extra environment variables for a provider process, or a provider shell,
 * that serves one thread only. Adapters whose process is shared across
 * threads must not apply them. Today this carries the thread's jj config
 * layer (see JjThreadLayer); the default adds nothing.
 */
export class ProviderThreadEnvironment extends Context.Reference<{
  readonly forThread: (threadId: ThreadId) => Effect.Effect<Readonly<Record<string, string>>>;
}>("t3/orchestration-v2/ProviderThreadEnvironment", {
  defaultValue: () => ({ forThread: () => Effect.succeed({}) }),
}) {}
