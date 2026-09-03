import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useSyncExternalStore } from "react";

import { deriveThreadTitleFromPrompt } from "../../lib/projectThreadStartTurn";

export interface PendingThreadIdentity {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
}

export interface PendingThreadRouteParams {
  readonly environmentId: string;
  readonly threadId: string;
}

export interface PendingThreadCreation {
  readonly title: string;
}

const pendingThreadCreations = new Map<string, PendingThreadCreation>();
const listeners = new Set<() => void>();

function pendingThreadKey(environmentId: string, threadId: string): string {
  return `${environmentId}\u0000${threadId}`;
}

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function makePendingThreadRouteParams(
  message: PendingThreadIdentity,
): PendingThreadRouteParams {
  return {
    environmentId: String(message.environmentId),
    threadId: String(message.threadId),
  };
}

export function rememberPendingThreadCreation(message: PendingThreadIdentity): void {
  pendingThreadCreations.set(
    pendingThreadKey(String(message.environmentId), String(message.threadId)),
    { title: deriveThreadTitleFromPrompt(message.text) },
  );
  emitChange();
}

export function forgetPendingThreadCreation(environmentId: string, threadId: string): void {
  if (pendingThreadCreations.delete(pendingThreadKey(environmentId, threadId))) {
    emitChange();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPendingThreadCreation(
  environmentId: string | null,
  threadId: string | null,
): PendingThreadCreation | null {
  if (environmentId === null || threadId === null) {
    return null;
  }
  return pendingThreadCreations.get(pendingThreadKey(environmentId, threadId)) ?? null;
}

export function usePendingThreadCreation(
  environmentId: string | null,
  threadId: string | null,
): PendingThreadCreation | null {
  return useSyncExternalStore(
    subscribe,
    () => getPendingThreadCreation(environmentId, threadId),
    () => null,
  );
}

export type ThreadRoutePresentation = "thread" | "pending-creation" | "loading" | "unavailable";

export function resolveThreadRoutePresentation(input: {
  readonly hasMatchingThread: boolean;
  readonly pendingCreation: boolean;
  readonly stillHydrating: boolean;
}): ThreadRoutePresentation {
  if (input.hasMatchingThread) {
    return "thread";
  }
  if (input.pendingCreation) {
    return "pending-creation";
  }
  return input.stillHydrating ? "loading" : "unavailable";
}

export function useThreadRoutePresentation(input: {
  readonly environmentId: string | null;
  readonly threadId: string | null;
  readonly hasMatchingThread: boolean;
  readonly stillHydrating: boolean;
}): {
  readonly pendingCreation: PendingThreadCreation | null;
  readonly presentation: ThreadRoutePresentation;
} {
  const pendingCreation = usePendingThreadCreation(input.environmentId, input.threadId);

  useEffect(() => {
    if (input.hasMatchingThread && input.environmentId !== null && input.threadId !== null) {
      forgetPendingThreadCreation(input.environmentId, input.threadId);
    }
  }, [input.environmentId, input.hasMatchingThread, input.threadId]);

  return {
    pendingCreation,
    presentation: resolveThreadRoutePresentation({
      hasMatchingThread: input.hasMatchingThread,
      pendingCreation: pendingCreation !== null,
      stillHydrating: input.stillHydrating,
    }),
  };
}
