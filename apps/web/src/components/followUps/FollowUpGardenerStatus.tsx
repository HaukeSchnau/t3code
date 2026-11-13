import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, FollowUpGardenerRun } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { useClientSettings } from "~/hooks/useSettings";
import { waitForThreadShell } from "~/state/entities";
import { followUpEnvironment } from "~/state/followUps";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { formatChatTimestampTooltip, formatRelativeTimeLabel } from "~/timestampFormat";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** When a home's nightly pass last ran, linking to its thread, and a way to run it now. */
export function FollowUpGardenerStatus(props: {
  readonly homeEnvironmentId: EnvironmentId;
  readonly lastRun: FollowUpGardenerRun | null;
}) {
  const { homeEnvironmentId, lastRun } = props;
  const canRun = useAtomValue(followUpEnvironment.runGardener.permissionAtom(homeEnvironmentId));
  const runGardener = useAtomCommand(followUpEnvironment.runGardener, { reportFailure: false });
  const navigate = useNavigate();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const nowMinute = useNowMinute();
  const [starting, setStarting] = useState(false);

  const run = async () => {
    setStarting(true);
    const result = await runGardener({ environmentId: homeEnvironmentId, input: {} });
    if (result._tag === "Failure") {
      setStarting(false);
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not start the nightly pass",
          description: failure instanceof Error ? failure.message : "An error occurred.",
        });
      }
      return;
    }
    const thread = scopeThreadRef(result.value.thread.environmentId, result.value.thread.threadId);
    // The thread reaches this client a moment after the server launches it.
    await waitForThreadShell(thread);
    setStarting(false);
    await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(thread) });
  };

  return (
    <span className="flex min-w-0 items-center gap-1 text-xs font-normal text-muted-foreground">
      {lastRun === null ? (
        <span className="truncate">Nightly pass has not run</span>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Link
                to="/$environmentId/$threadId"
                params={buildThreadRouteParams(
                  scopeThreadRef(lastRun.thread.environmentId, lastRun.thread.threadId),
                )}
                className="truncate underline-offset-2 hover:text-foreground hover:underline"
              />
            }
          >
            Nightly pass ran{" "}
            {formatRelativeTimeLabel(lastRun.startedAt, Date.parse(`${nowMinute}:00.000Z`))}
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            Started {formatChatTimestampTooltip(lastRun.startedAt, timestampFormat)}. Its last
            message is the report.
          </TooltipPopup>
        </Tooltip>
      )}
      {canRun ? (
        <Button size="xs" variant="ghost-muted" disabled={starting} onClick={() => void run()}>
          {starting ? "Starting…" : "Run now"}
        </Button>
      ) : null}
    </span>
  );
}
