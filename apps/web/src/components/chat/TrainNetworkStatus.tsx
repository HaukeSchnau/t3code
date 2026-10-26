import {
  projectEnvironmentConnectionFreshness,
  type EnvironmentConnectionFreshnessProjection,
} from "@t3tools/client-runtime/state/connection-freshness";
import type { EnvironmentId } from "@t3tools/contracts";
import { CheckCircle2Icon, LoaderCircleIcon, WifiOffIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { environmentShell } from "~/state/shell";
import { Button } from "../ui/button";
import {
  deriveTrainNetworkExperience,
  NETWORK_DEGRADATION_HOLD_MS,
  NETWORK_RECOVERY_HOLD_MS,
  RECOVERED_NETWORK_EXPERIENCE,
  retryCountdownText,
  type TrainNetworkExperienceView,
} from "./trainNetworkExperience";

interface TrainNetworkStatusProps {
  readonly projection: EnvironmentConnectionFreshnessProjection | null;
  /** Disables time holds for deterministic screenshot fixtures. */
  readonly immediate?: boolean;
  readonly className?: string;
  readonly onReconnect?: () => void;
  readonly onOpenConnections?: () => void;
}

/**
 * Subscribes to the environment's connection and shell here, so their pushes re-render this strip
 * and not the chat around it.
 */
export function EnvironmentNetworkStatus({
  environmentId,
  ...props
}: Omit<TrainNetworkStatusProps, "projection" | "onReconnect"> & {
  readonly environmentId: EnvironmentId;
}) {
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow);
  const connection = useEnvironmentQuery(environmentCatalog.stateAtom(environmentId)).data;
  const shell = useEnvironmentQuery(environmentShell.stateAtom(environmentId)).data;
  const projection =
    connection !== null && shell !== null
      ? projectEnvironmentConnectionFreshness(connection, shell)
      : null;
  return (
    <TrainNetworkStatus
      projection={projection}
      onReconnect={() => void retryEnvironment(environmentId)}
      {...props}
    />
  );
}

export function TrainNetworkStatus({
  projection,
  immediate = false,
  className,
  onReconnect,
  onOpenConnections,
}: TrainNetworkStatusProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const nextView = projection === null ? null : deriveTrainNetworkExperience(projection, nowMs);
  const fullyRecovered =
    projection?.connection.phase === "connected" && projection.snapshot.status === "live";
  const [displayedView, setDisplayedView] = useState<TrainNetworkExperienceView | null>(() =>
    immediate ? nextView : null,
  );
  const previouslyDegradedRef = useRef(false);

  // oxlint-disable-next-line t3code/react-effect-budget -- The anti-flicker holds are timers that follow connection changes.
  useEffect(() => {
    if (immediate) {
      // oxlint-disable-next-line react/set-state-in-effect -- The hold timers follow connection changes the supervisor reports.
      setDisplayedView(nextView);
      previouslyDegradedRef.current = nextView?.kind === "degraded";
      return;
    }

    if (nextView !== null) {
      const delay = previouslyDegradedRef.current ? 0 : NETWORK_DEGRADATION_HOLD_MS;
      const timeout = window.setTimeout(() => {
        previouslyDegradedRef.current = true;
        setDisplayedView(nextView);
      }, delay);
      return () => window.clearTimeout(timeout);
    }

    if (!previouslyDegradedRef.current) {
      setDisplayedView(null);
      return;
    }

    if (!fullyRecovered) {
      setDisplayedView(null);
      return;
    }

    previouslyDegradedRef.current = false;
    setDisplayedView(RECOVERED_NETWORK_EXPERIENCE);
    const timeout = window.setTimeout(() => setDisplayedView(null), NETWORK_RECOVERY_HOLD_MS);
    return () => window.clearTimeout(timeout);
  }, [fullyRecovered, immediate, nextView]);

  // oxlint-disable-next-line t3code/react-effect-budget -- The retry countdown ticks with the wall clock.
  useEffect(() => {
    if (nextView?.retryRemainingMs === null || nextView?.retryRemainingMs === undefined) return;
    const interval = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [nextView?.retryRemainingMs]);

  if (displayedView === null) return null;

  const retryText = retryCountdownText(displayedView.retryRemainingMs);
  const recovered = displayedView.kind === "recovered";
  const canReconnect =
    displayedView.kind === "degraded" &&
    (displayedView.title === "Not connected" ||
      displayedView.title === "Offline" ||
      displayedView.title === "Connection failed");

  return (
    <div
      data-train-network-status={displayedView.kind}
      className={cn(
        "mx-auto mb-2 flex max-w-3xl flex-wrap items-center gap-2.5 rounded-xl border px-3 py-2 text-xs shadow-xs sm:flex-nowrap",
        "transition-[opacity,background-color,border-color] duration-150 motion-reduce:transition-none",
        recovered
          ? "border-success/25 bg-success/8 text-success"
          : "border-warning/30 bg-warning/8 text-foreground",
        className,
      )}
    >
      {recovered ? (
        <CheckCircle2Icon className="size-4 shrink-0" aria-hidden="true" />
      ) : displayedView.title === "Offline" || displayedView.title === "Connection failed" ? (
        <WifiOffIcon className="size-4 shrink-0 text-warning" aria-hidden="true" />
      ) : (
        <LoaderCircleIcon
          className="size-4 shrink-0 animate-spin text-warning motion-reduce:animate-none"
          aria-hidden="true"
        />
      )}
      <div className="min-w-0 flex-1 basis-[calc(100%-2rem)] sm:flex sm:basis-auto sm:items-baseline sm:gap-2">
        <span className="font-medium">{displayedView.title}</span>
        <span className="block truncate text-muted-foreground sm:inline">
          {displayedView.detail}
        </span>
      </div>
      {displayedView.attempt !== null || retryText !== null ? (
        <span
          className="ml-6 shrink-0 tabular-nums text-muted-foreground sm:ml-0"
          aria-hidden="true"
        >
          {displayedView.attempt !== null ? `Attempt ${displayedView.attempt}` : null}
          {displayedView.attempt !== null && retryText !== null ? " · " : null}
          {retryText}
        </span>
      ) : null}
      {canReconnect ? (
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {onReconnect ? (
            <Button type="button" size="xs" onClick={onReconnect}>
              Reconnect
            </Button>
          ) : null}
          {onOpenConnections ? (
            <Button type="button" size="xs" variant="ghost" onClick={onOpenConnections}>
              Connections
            </Button>
          ) : null}
        </div>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {displayedView.announcement}
      </span>
    </div>
  );
}
