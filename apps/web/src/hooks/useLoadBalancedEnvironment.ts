import { chooseLoadBalancedEnvironment } from "@t3tools/client-runtime/load-balancing";
import type { EnvironmentId } from "@t3tools/contracts";

/** Only mounted for unresolved automatic drafts, so idle clients do not poll hosts. */
export function useLoadBalancedEnvironment(
  environmentIds: readonly EnvironmentId[],
  weights: Readonly<Record<string, number>>,
) {
  // The V2 server config stream no longer exposes the legacy host-resources
  // RPC. Keep this hook's public shape until the load-balancing surface gets a
  // V2 telemetry query; callers can continue to render the unresolved state.
  const refresh = (_ids: readonly EnvironmentId[]) => undefined;
  const environmentId = chooseLoadBalancedEnvironment(
    environmentIds.map((candidate) => ({
      environmentId: candidate,
      resources: null,
      weight: weights[candidate] ?? 50,
    })),
    Date.now(),
  ) as EnvironmentId | null;
  return {
    refresh,
    pending: false,
    environmentId,
    failed: false,
  };
}
