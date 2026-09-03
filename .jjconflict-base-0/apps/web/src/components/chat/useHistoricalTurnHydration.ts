import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  OrchestrationThreadHistoricalActivityGroup,
  ScopedThreadRef,
  TurnId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  acceptHydratedHistoricalTurn,
  hydratedHistoricalTurnIsCurrent,
  type HydratedHistoricalTurn,
} from "../../historicalActivityHydration";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export function useHistoricalTurnHydration(
  threadRef: ScopedThreadRef | null,
  groups: ReadonlyArray<OrchestrationThreadHistoricalActivityGroup>,
) {
  const loadThreadTurnActivities = useAtomCommand(threadEnvironment.loadTurnActivities, {
    reportFailure: false,
  });
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  const routeRef = useRef({ threadRef, threadKey, groups });
  routeRef.current = { threadRef, threadKey, groups };
  const [hydrated, setHydrated] = useState<{
    readonly threadKey: string | null;
    readonly byTurnId: ReadonlyMap<TurnId, HydratedHistoricalTurn>;
  }>({ threadKey, byTurnId: new Map() });
  const currentByTurnId = hydrated.threadKey === threadKey ? hydrated.byTurnId : new Map();

  useEffect(() => {
    setHydrated((current) =>
      current.threadKey === threadKey
        ? current
        : { threadKey, byTurnId: new Map<TurnId, HydratedHistoricalTurn>() },
    );
  }, [threadKey]);

  const historicalTurnIds = useMemo(() => new Set(groups.map((group) => group.turnId)), [groups]);
  const hydratedHistoricalTurnIds = useMemo(
    () =>
      new Set(
        groups.flatMap((group) =>
          hydratedHistoricalTurnIsCurrent(group, currentByTurnId.get(group.turnId))
            ? [group.turnId]
            : [],
        ),
      ),
    [currentByTurnId, groups],
  );

  const hydrateHistoricalTurn = useCallback(
    async (turnId: TurnId): Promise<boolean> => {
      if (!threadRef || threadKey === null) return false;
      const group = groups.find((entry) => entry.turnId === turnId);
      if (!group) return true;
      if (hydratedHistoricalTurnIsCurrent(group, currentByTurnId.get(turnId))) return true;

      const requestedThreadKey = threadKey;
      const result = await loadThreadTurnActivities({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, turnId },
      });
      if (result._tag !== "Success") return false;

      const currentRoute = routeRef.current;
      if (
        currentRoute.threadKey !== requestedThreadKey ||
        currentRoute.threadRef?.threadId !== threadRef.threadId
      ) {
        return false;
      }
      const currentGroup = currentRoute.groups.find((entry) => entry.turnId === turnId);
      if (!currentGroup) return false;
      const accepted = acceptHydratedHistoricalTurn({
        threadId: threadRef.threadId,
        group: currentGroup,
        snapshot: result.value,
      });
      if (!accepted) return false;

      setHydrated((current) => {
        if (current.threadKey !== requestedThreadKey) return current;
        const next = new Map(current.byTurnId);
        next.set(turnId, accepted);
        return { threadKey: current.threadKey, byTurnId: next };
      });
      return true;
    },
    [currentByTurnId, groups, loadThreadTurnActivities, threadKey, threadRef],
  );

  const releaseHistoricalTurn = useCallback((turnId: TurnId) => {
    setHydrated((current) => {
      if (!current.byTurnId.has(turnId)) return current;
      const next = new Map(current.byTurnId);
      next.delete(turnId);
      return { threadKey: current.threadKey, byTurnId: next };
    });
  }, []);

  return {
    historicalTurnIds,
    hydratedHistoricalTurnIds,
    hydrateHistoricalTurn,
    releaseHistoricalTurn,
  };
}
