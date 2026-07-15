import type { EnvironmentConnectionFreshnessProjection } from "@t3tools/client-runtime/state/connection-freshness";
import { useEffect, useMemo, useState } from "react";

import {
  presentRemoteQueue,
  presentTrainConnectionStatus,
  trainStatusVisibilityDelayMs,
  type TrainConnectionStatus,
} from "./trainNetworkPresentation";

export function useTrainNetworkPresentation(input: {
  readonly projection: EnvironmentConnectionFreshnessProjection | null;
  readonly fallbackStatus: TrainConnectionStatus | null;
  readonly environmentLabel: string | null;
  readonly hasThreadContent: boolean;
  readonly remoteQueueCount: number;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const nextStatus = useMemo(
    () =>
      input.projection
        ? presentTrainConnectionStatus({
            projection: input.projection,
            environmentLabel: input.environmentLabel,
            nowMs,
            hasThreadContent: input.hasThreadContent,
          })
        : input.fallbackStatus,
    [
      input.environmentLabel,
      input.fallbackStatus,
      input.hasThreadContent,
      input.projection,
      nowMs,
    ],
  );
  const [visibleStatus, setVisibleStatus] = useState<TrainConnectionStatus | null>(null);
  const retryDeadline =
    input.projection?.connection.stage === "waiting-to-retry"
      ? input.projection.connection.retryAt
      : null;

  useEffect(() => {
    if (retryDeadline === null) return;
    setNowMs(Date.now());
    const interval = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [retryDeadline]);

  useEffect(() => {
    const delay = trainStatusVisibilityDelayMs(visibleStatus, nextStatus);
    if (delay === 0) {
      setVisibleStatus(nextStatus);
      return;
    }
    const timeout = setTimeout(() => setVisibleStatus(nextStatus), delay);
    return () => clearTimeout(timeout);
  }, [nextStatus, visibleStatus]);

  return {
    connectionStatus: visibleStatus,
    remoteQueueStatus: presentRemoteQueue(input.remoteQueueCount),
  } as const;
}
