import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * Environment for a provider process or shell that serves one thread only: the
 * thread's jj config (patches/jujutsu.md). Adapters whose process serves several threads must
 * not apply it.
 */
export interface ProviderThreadEnvironmentShape {
  /** Variables for the thread's processes and shell commands. */
  readonly forThread: (threadId: ThreadId) => Effect.Effect<Readonly<Record<string, string>>>;
}

export const ProviderThreadEnvironment = Context.Reference<ProviderThreadEnvironmentShape>(
  "@t3tools/provider-core/ProviderThreadEnvironment",
  {
    defaultValue: () => ({
      forThread: () => Effect.succeed({}),
    }),
  },
);
