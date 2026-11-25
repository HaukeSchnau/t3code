import { useAtomValue } from "@effect/atom-react";
import { useMessages } from "gt-react";
import type { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentAtomList, environmentIdsKey } from "../state/environmentAtomList";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";

// Live settings: a remote environment's serverConfig keeps its connect-time settings.
const placementWeightsAtom = environmentAtomList("placement-weights", (environmentId) =>
  Atom.map(
    serverEnvironment.settingsValueAtom(environmentId),
    (settings) => settings?.placementWeight,
  ),
);

/** Each machine's own Auto balance weight; null when unset, undefined while settings load. */
export function usePlacementWeights(environmentIds: readonly EnvironmentId[]) {
  return useAtomValue(placementWeightsAtom(environmentIdsKey(environmentIds)));
}

const placementAgentLimitsAtom = environmentAtomList("placement-agent-limits", (environmentId) =>
  Atom.map(
    serverEnvironment.settingsValueAtom(environmentId),
    (settings) => settings?.placementAgentLimit,
  ),
);

/** Each machine's own agent limit for placement; null for none, undefined while loading. */
export function usePlacementAgentLimits(environmentIds: readonly EnvironmentId[]) {
  return useAtomValue(placementAgentLimitsAtom(environmentIdsKey(environmentIds)));
}

/**
 * Where the server's placement would start a new thread of this project now. Only mounted for
 * automatic drafts, so idle clients do not ask.
 */
export function usePlacementPreview(
  target: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly instanceId: ProviderInstanceId | null;
  } | null,
) {
  const messages = useMessages();
  return useEnvironmentQuery(
    target === null
      ? null
      : serverEnvironment.placementPreview({
          environmentId: target.environmentId,
          input: {
            projectId: target.projectId,
            ...(target.instanceId === null ? {} : { instanceId: target.instanceId }),
          },
        }),
    messages,
  );
}
