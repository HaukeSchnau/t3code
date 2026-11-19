import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import { isMessageFreeTurn } from "@t3tools/shared/codexTurnContinuation";

/**
 * A message the user wrote, not a notification, delegated result, scheduled prompt, or provider echo.
 */
export function isUserTurn(
  message: Pick<
    OrchestrationV2ConversationMessage,
    | "role"
    | "createdBy"
    | "creationSource"
    | "notification"
    | "delegatedCompletion"
    | "scheduledTaskId"
  >,
): boolean {
  return (
    message.role === "user" &&
    message.createdBy === "user" &&
    message.creationSource !== "provider" &&
    message.notification === undefined &&
    message.delegatedCompletion === undefined &&
    message.scheduledTaskId === undefined
  );
}

/**
 * A user turn that carries text, attachments or context, so a Codex Resume or automatic retry,
 * which carry none, does not count. `ProjectionStore.getLatestUserReply` repeats this rule in SQL.
 */
export function isUserReply(
  message: Parameters<typeof isUserTurn>[0] &
    Pick<OrchestrationV2ConversationMessage, "text" | "attachments" | "context">,
): boolean {
  return isUserTurn(message) && !isMessageFreeTurn(message);
}
