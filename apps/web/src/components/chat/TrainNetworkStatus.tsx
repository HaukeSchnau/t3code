import {
  projectEnvironmentConnectionFreshness,
  type EnvironmentConnectionFreshnessProjection,
} from "@t3tools/client-runtime/state/connection-freshness";
import type { EnvironmentId } from "@t3tools/contracts";
import { CheckCircle2Icon, LoaderCircleIcon, WifiOffIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { T, useMessages, Var } from "gt-react";

import { environmentCatalog } from "~/connection/catalog";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { environmentShell } from "~/state/shell";
import { Button } from "../ui/button";
import { ComposerBanner } from "./ComposerBanner";
import {
  deriveTrainNetworkExperience,
  NETWORK_DEGRADATION_HOLD_MS,
  NETWORK_RECOVERY_HOLD_MS,
  recoveredNetworkExperience,
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
  const m = useMessages();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const nextView = projection === null ? null : deriveTrainNetworkExperience(projection, nowMs, m);
  const fullyRecovered =
    projection?.connection.phase === "connected" && projection.snapshot.status === "live";
  const [displayedView, setDisplayedView] = useState<TrainNetworkExperienceView | null>(() =>
    immediate ? nextView : null,
  );
  const previouslyDegradedRef = useRef(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The anti-flicker holds are timers that follow connection changes.
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
    // Resolved here, outside render, with the active language; the view shows for half a second.
    setDisplayedView(recoveredNetworkExperience());
    const timeout = window.setTimeout(() => setDisplayedView(null), NETWORK_RECOVERY_HOLD_MS);
    return () => window.clearTimeout(timeout);
  }, [fullyRecovered, immediate, nextView]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The retry countdown ticks with the wall clock.
  useEffect(() => {
    if (nextView?.retryRemainingMs === null || nextView?.retryRemainingMs === undefined) return;
    const interval = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [nextView?.retryRemainingMs]);

  if (displayedView === null) return null;

  const retryText = retryCountdownText(displayedView.retryRemainingMs, m);
  const recovered = displayedView.kind === "recovered";
  const canReconnect =
    displayedView.kind === "degraded" &&
    (displayedView.state === "not-connected" ||
      displayedView.state === "offline" ||
      displayedView.state === "connection-failed");

  const reconnectActions =
    canReconnect && (onReconnect !== undefined || onOpenConnections !== undefined);

  return (
    <ComposerBanner.Root
      data-train-network-status={displayedView.kind}
      variant={recovered ? "success" : "warning"}
      detached
      density="comfortable"
      className={cn("mb-2", className)}
    >
      <ComposerBanner.Row layout="wrap-actions">
        <ComposerBanner.Icon>
          {recovered ? (
            <CheckCircle2Icon />
          ) : displayedView.state === "offline" || displayedView.state === "connection-failed" ? (
            <WifiOffIcon />
          ) : (
            <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
          )}
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="items-baseline whitespace-nowrap">
          <span className="min-w-0 truncate text-foreground">{displayedView.title}</span>
          <span className="w-0 min-w-0 grow truncate text-muted-foreground @max-[400px]:sr-only">
            {displayedView.detail}
          </span>
        </ComposerBanner.Content>
        {displayedView.attempt !== null || retryText !== null || reconnectActions ? (
          <ComposerBanner.Actions>
            {displayedView.attempt !== null ? (
              <ComposerBanner.Count aria-hidden="true">
                <T>
                  Attempt <Var>{displayedView.attempt}</Var>
                </T>
              </ComposerBanner.Count>
            ) : null}
            {retryText !== null ? (
              <ComposerBanner.Count aria-hidden="true">{retryText}</ComposerBanner.Count>
            ) : null}
            {canReconnect && onReconnect ? (
              <Button type="button" size="xs" onClick={onReconnect}>
                <T>Reconnect</T>
              </Button>
            ) : null}
            {canReconnect && onOpenConnections ? (
              <Button type="button" size="xs" variant="ghost" onClick={onOpenConnections}>
                <T>Connections</T>
              </Button>
            ) : null}
          </ComposerBanner.Actions>
        ) : null}
      </ComposerBanner.Row>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {displayedView.announcement}
      </span>
    </ComposerBanner.Root>
  );
}
