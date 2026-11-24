import type { ServerSettings, ServerSettingsPatch } from "@t3tools/contracts";

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
