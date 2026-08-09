import type { MessageId, ScopedThreadRef, TurnId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { buildThreadRouteParams } from "../../threadRoutes";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function useCodexMessageForking(activeThreadRef: ScopedThreadRef | null) {
  const navigate = useNavigate();

  return useCallback(
    async (messageId: MessageId, turnId: TurnId, options: { workspace?: "new" } = {}) => {
      if (!activeThreadRef) {
        return;
      }
      const api = readEnvironmentApi(activeThreadRef.environmentId);
      if (!api) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not fork from message",
            description: "Environment API unavailable.",
          }),
        );
        return;
      }

      const result = await settlePromise(() =>
        api.codex.forkThread({
          threadId: activeThreadRef.threadId,
          lastTurnId: turnId,
          sourceMessageId: messageId,
          ...(options.workspace === "new"
            ? { workspace: { mode: "new" as const, kind: "auto" as const } }
            : {}),
        }),
      );
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not fork from message",
            description: error instanceof Error ? error.message : "Failed to create fork.",
          }),
        );
        return;
      }

      const forkedThreadRef = scopeThreadRef(activeThreadRef.environmentId, result.value.threadId);
      const navigateResult = await settlePromise(() =>
        navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(forkedThreadRef),
        }),
      );
      if (navigateResult._tag === "Failure") {
        const error = squashAtomCommandFailure(navigateResult);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Fork created, but could not open it",
            description: error instanceof Error ? error.message : "Navigation failed.",
          }),
        );
        return;
      }

      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: options.workspace === "new" ? "Forked into new workspace" : "Forked from message",
          description:
            options.workspace === "new"
              ? "Opened the fork with a copied workspace at the selected response."
              : "Opened the fork with history up to that response.",
        }),
      );
    },
    [activeThreadRef, navigate],
  );
}
