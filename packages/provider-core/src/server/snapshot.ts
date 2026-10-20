import type { ProviderUsageLimitsUpdate, ServerProvider } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { ProviderMaintenanceCapabilities } from "./maintenance.ts";

export interface ManagedServerProvider {
  /**
   * Cached between reads; pass
   * `{ fresh: true }` before executing an update so it never trusts a
   * resolution older than the click.
   */
  readonly resolveMaintenance: (options?: {
    readonly fresh?: boolean;
  }) => Effect.Effect<ProviderMaintenanceCapabilities>;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly refresh: Effect.Effect<ServerProvider>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
  /**
   * Sparse: windows merge by id and an
   * update with no usable window leaves the snapshot untouched.
   */
  readonly applyUsageLimits: (
    update: ProviderUsageLimitsUpdate & { readonly checkedAt: string },
  ) => Effect.Effect<void>;
  /**
   * Re-read subscription limits without the status probe
   * (patches/usage-limits-refresh.md). `"current"`: the published limits are
   * as fresh as the provider allows, or the account has none. `"needsProbe"`:
   * only the status probe reports this provider's limits, or the direct read
   * could not run this time. A provider without it counts as `"needsProbe"`.
   */
  readonly refreshUsageLimits?: Effect.Effect<"current" | "needsProbe">;
}
