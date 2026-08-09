import { type ProviderRuntimeEvent, defaultInstanceIdForDriver } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { adjustWorkloadGauge } from "../diagnostics/WorkloadDiagnostics.ts";

interface RuntimeSessionDedupeState {
  readonly activeEventIdsByScope: Map<string, Set<string>>;
  readonly completedItemScopes: Set<string>;
  readonly completedTurnIds: Set<string>;
}

function runtimeSessionKey(event: ProviderRuntimeEvent): string {
  const providerInstanceId = event.providerInstanceId ?? defaultInstanceIdForDriver(event.provider);
  return `${event.provider}\0${providerInstanceId}\0${event.threadId}`;
}

function runtimeEventScopeKey(event: ProviderRuntimeEvent): string {
  const turnScope = `turn:${event.turnId ?? "session"}`;
  if (event.itemId !== undefined) {
    return `${turnScope}\0item:${event.itemId}`;
  }
  if (
    event.type === "content.delta" ||
    event.type === "item.started" ||
    event.type === "item.updated" ||
    event.type === "item.completed"
  ) {
    return `${turnScope}\0item:anonymous`;
  }
  return `${turnScope}\0lifecycle:${event.type}`;
}

function runtimeTurnScopePrefix(turnId: string): string {
  return `turn:${turnId}\0`;
}

export function makeProviderRuntimeEventLedger() {
  const sessions = new Map<string, RuntimeSessionDedupeState>();

  const hasProcessed = (event: ProviderRuntimeEvent): boolean => {
    const state = sessions.get(runtimeSessionKey(event));
    if (state === undefined) return false;
    if (event.turnId !== undefined && state.completedTurnIds.has(String(event.turnId))) return true;
    const scopeKey = runtimeEventScopeKey(event);
    return (
      state.completedItemScopes.has(scopeKey) ||
      (state.activeEventIdsByScope.get(scopeKey)?.has(String(event.eventId)) ?? false)
    );
  };

  const rememberProcessed = (event: ProviderRuntimeEvent) =>
    Effect.sync(() => {
      const sessionKey = runtimeSessionKey(event);
      if (event.type === "session.exited") {
        const existing = sessions.get(sessionKey);
        if (existing !== undefined) {
          const retainedEventCount = Array.from(existing.activeEventIdsByScope.values()).reduce(
            (total, eventIds) => total + eventIds.size,
            0,
          );
          adjustWorkloadGauge("ingestion.dedupe.events.active", -retainedEventCount);
        }
        sessions.delete(sessionKey);
        return;
      }

      const state = sessions.get(sessionKey) ?? {
        activeEventIdsByScope: new Map<string, Set<string>>(),
        completedItemScopes: new Set<string>(),
        completedTurnIds: new Set<string>(),
      };
      const scopeKey = runtimeEventScopeKey(event);
      const eventIds = state.activeEventIdsByScope.get(scopeKey) ?? new Set<string>();
      if (!eventIds.has(String(event.eventId))) {
        eventIds.add(String(event.eventId));
        adjustWorkloadGauge("ingestion.dedupe.events.active", 1);
      }
      state.activeEventIdsByScope.set(scopeKey, eventIds);

      if (event.type === "item.completed" && event.itemId !== undefined) {
        state.activeEventIdsByScope.delete(scopeKey);
        adjustWorkloadGauge("ingestion.dedupe.events.active", -eventIds.size);
        state.completedItemScopes.add(scopeKey);
      }
      if (event.type === "turn.completed" || event.type === "turn.aborted") {
        const turnId = event.turnId;
        if (turnId !== undefined) {
          const prefix = runtimeTurnScopePrefix(String(turnId));
          for (const [candidateScope, candidateEventIds] of state.activeEventIdsByScope) {
            if (!candidateScope.startsWith(prefix)) continue;
            state.activeEventIdsByScope.delete(candidateScope);
            adjustWorkloadGauge("ingestion.dedupe.events.active", -candidateEventIds.size);
          }
          for (const candidateScope of state.completedItemScopes) {
            if (candidateScope.startsWith(prefix)) state.completedItemScopes.delete(candidateScope);
          }
          state.completedTurnIds.add(String(turnId));
        }
      }
      sessions.set(sessionKey, state);
    });

  const reset = Effect.sync(() => {
    let retainedEventCount = 0;
    for (const state of sessions.values()) {
      for (const eventIds of state.activeEventIdsByScope.values()) {
        retainedEventCount += eventIds.size;
      }
    }
    adjustWorkloadGauge("ingestion.dedupe.events.active", -retainedEventCount);
    sessions.clear();
  });

  return { hasProcessed, rememberProcessed, reset } as const;
}
