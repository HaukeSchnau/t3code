import type { ThreadId } from "@t3tools/contracts";

export const T3CODE_THREAD_ID_ENV = "T3CODE_THREAD_ID";

/** Adds caller context for `t3 thread` commands run by a provider process. */
export const withThreadCliEnvironment = (
  environment: NodeJS.ProcessEnv | undefined,
  threadId: ThreadId,
): NodeJS.ProcessEnv => ({
  ...(environment ?? process.env),
  [T3CODE_THREAD_ID_ENV]: threadId,
});
