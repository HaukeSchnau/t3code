import type { OrchestrationV2AppThread, OrchestrationV2Command } from "@t3tools/contracts";

/**
 * Whether a finished title generation may land. First-turn and explicit
 * generations own the thread's in-flight marker. A background refresh holds no
 * marker, so it lands only while the automatic title it started from is still
 * current: a rename, or a regeneration started meanwhile, wins.
 */
export function acceptsGeneratedTitle(
  thread: Pick<OrchestrationV2AppThread, "title" | "titleMode" | "titleRegeneration">,
  command: Pick<
    Extract<OrchestrationV2Command, { readonly type: "thread.title.regeneration.complete" }>,
    "requestId" | "expectedTitle"
  >,
): boolean {
  if (command.expectedTitle === undefined) {
    return thread.titleRegeneration?.requestId === command.requestId;
  }
  return (
    thread.titleMode === "automatic" &&
    thread.titleRegeneration == null &&
    thread.title === command.expectedTitle
  );
}
