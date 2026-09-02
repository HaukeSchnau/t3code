/**
 * Human corrections as store dispatches. Every action appends ordinary facts
 * after the cursor, which is exactly what the production CLI verbs would
 * persist; nothing here mutates derived state directly.
 */
import { createContext, use, useMemo } from "react";

import type { FixtureState, FixtureWaitCondition } from "./model";
import { displayLabel } from "./presentation";
import { useOrchestrationFixtureStore } from "./store";

export interface FixtureNavigation {
  readonly openThread: (threadId: string) => void;
}

/** Standalone mode navigates through the store; the integrated route supplies the router. */
export const FixtureNavigationContext = createContext<FixtureNavigation | null>(null);

export function useFixtureNavigation(): FixtureNavigation {
  const provided = use(FixtureNavigationContext);
  const openThread = useOrchestrationFixtureStore((store) => store.openThread);
  return useMemo(() => provided ?? { openThread }, [provided, openThread]);
}

export function useFixtureActions() {
  const dispatch = useOrchestrationFixtureStore((store) => store.dispatch);
  return useMemo(
    () => ({
      moveToEffort(threadId: string, effortId: string | null) {
        dispatch({ type: "effort.member.moved", threadId, effortId });
      },
      cancelWait(waitId: string) {
        dispatch({ type: "wait.cancelled", waitId });
      },
      changeWait(waitId: string, condition: FixtureWaitCondition) {
        dispatch({ type: "wait.changed", waitId, condition });
      },
      closeEffort(effortId: string, stopMembers: boolean) {
        dispatch({ type: "effort.closed", effortId, stopMembers });
      },
      reopenEffort(effortId: string) {
        dispatch({ type: "effort.reopened", effortId });
      },
      resolveApproval(threadId: string, approved: boolean) {
        dispatch({ type: "approval.resolved", threadId, approved });
      },
      stopThread(threadId: string) {
        dispatch({ type: "thread.stopped", threadId });
      },
      /** Creates a successor thread with the same brief and records the replacement edge. */
      retryThread(state: FixtureState, threadId: string) {
        const thread = state.threads[threadId];
        const delegation = state.delegations[threadId];
        if (thread === undefined) return;
        const attempt =
          Object.values(state.replacements).filter((id) => id.startsWith(`${threadId}-retry`))
            .length + 1;
        const brief = thread.timeline.find(
          (item) => item.kind === "message" && item.role === "user",
        );
        const label = displayLabel(state, threadId).replace(/ \(retry(?: \d+)?\)$/, "");
        const suffix = attempt === 1 ? "(retry)" : `(retry ${attempt})`;
        dispatch({
          type: "thread.created",
          thread: {
            id: `${threadId}-retry-${attempt}`,
            projectId: thread.projectId,
            title: `${thread.title.replace(/ \(retry(?: \d+)?\)$/, "")} ${suffix}`,
            provider: thread.provider,
            model: thread.model,
            branch: thread.branch,
            worktree: thread.worktree,
          },
          prompt: brief?.kind === "message" ? brief.text : "Retry the previous brief.",
          replaces: threadId,
          ...(delegation
            ? {
                delegation: {
                  parentId: delegation.parentId,
                  label: `${label} ${suffix}`,
                  effortId: thread.effortId,
                  turnId: `${delegation.turnId}:retry-${attempt}`,
                },
              }
            : {}),
        });
      },
      sendMessage(threadId: string, text: string) {
        dispatch({ type: "thread.message", threadId, role: "user", text });
        dispatch({
          type: "thread.status",
          threadId,
          status: "running",
          activity: "Reading your message",
        });
      },
    }),
    [dispatch],
  );
}
