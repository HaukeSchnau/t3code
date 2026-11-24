import type {
  HostResourcesSnapshot,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import { freeAgentSlots, PLACEMENT_REPORT_FRESH_MS } from "@t3tools/shared/placement";

/** Callers supply only connected machines hosting the project and selected provider. */
export function chooseLoadBalancedEnvironment(
  candidates: ReadonlyArray<{
    environmentId: string;
    resources: HostResourcesSnapshot | null;
    /** Client receipt time avoids comparing clocks on different machines. */
    receivedAt?: number;
    weight: number;
  }>,
  now: number,
): string | null {
  let selected: string | null = null;
  let bestScore = 0;
  for (const { environmentId, resources, receivedAt, weight } of candidates) {
    const sampledAt = receivedAt ?? resources?.sampledAt ?? 0;
    if (
      !resources ||
      !Number.isFinite(weight) ||
      weight <= 0 ||
      now - sampledAt > PLACEMENT_REPORT_FRESH_MS ||
      sampledAt > now + 5_000 ||
      resources.totalMemoryBytes <= 0
    ) {
      continue;
    }
    const score = weight * freeAgentSlots({ resources }).preference;
    if (score > bestScore) {
      selected = environmentId;
      bestScore = score;
    }
  }
  return selected;
}

/** Moves a browser's Auto balance choice for one machine onto that machine, while it has none. */
export function placementMigrationPatch(
  settings: Pick<ServerSettings, "placementWeight">,
  legacy: {
    readonly loadBalancingEnabled: boolean;
    readonly loadBalancingWeights: Readonly<Record<string, number>>;
  },
  environmentId: string,
): ServerSettingsPatch | null {
  if (settings.placementWeight !== null || !legacy.loadBalancingEnabled) return null;
  return { migratePlacementWeight: legacy.loadBalancingWeights[environmentId] ?? 50 };
}
