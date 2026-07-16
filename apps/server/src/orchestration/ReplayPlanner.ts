import type { OrchestrationReplayProbe } from "../persistence/Services/OrchestrationEventStore.ts";

export interface ReplayThresholds {
  readonly maxEvents: number;
  readonly maxPayloadBytes: number;
}

export type ReplayPlan =
  | { readonly strategy: "events"; readonly reason: "bounded" }
  | {
      readonly strategy: "snapshot";
      readonly reason: "event-count" | "payload-bytes";
    };

/**
 * Selects the cheaper reconnect representation from bounded persistence work.
 * Event-count truncation wins over byte size because it proves more rows exist
 * than the probe loaded, independent of the sampled payload distribution.
 */
export function planReplay(
  probe: OrchestrationReplayProbe,
  thresholds: ReplayThresholds,
): ReplayPlan {
  if (probe.truncated || probe.eventCount > thresholds.maxEvents) {
    return { strategy: "snapshot", reason: "event-count" };
  }
  if (probe.payloadBytes > thresholds.maxPayloadBytes) {
    return { strategy: "snapshot", reason: "payload-bytes" };
  }
  return { strategy: "events", reason: "bounded" };
}
