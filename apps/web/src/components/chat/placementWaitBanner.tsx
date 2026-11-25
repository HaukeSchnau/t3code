import type { ThreadPlacement } from "@t3tools/contracts";
import { msg, T } from "gt-react";
import { HourglassIcon } from "lucide-react";

import type { MessageResolver } from "../../i18n/messages";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** A placed thread waiting for room on its machine; its first run has not started (decision 1). */
export function placementWaitBannerItem(input: {
  readonly placement: ThreadPlacement;
  readonly busy: boolean;
  /** A read-only connection sees the wait without its actions. */
  readonly canOperate: boolean;
  readonly onStartNow: () => void;
  readonly onCancel: () => void;
  readonly resolve: MessageResolver;
}): ComposerBannerStackItem {
  return {
    id: `placement-wait:${input.placement.environmentId}`,
    variant: "info",
    group: "environment",
    icon: <HourglassIcon />,
    title: input.resolve(msg("Waiting for room on {machine}", { machine: input.placement.label })),
    description: input.placement.reason,
    ...(!input.canOperate
      ? {}
      : {
          actions: (
            <>
              <Button size="xs" variant="ghost" disabled={input.busy} onClick={input.onStartNow}>
                <T>Start anyway</T>
              </Button>
              <Button size="xs" variant="ghost" disabled={input.busy} onClick={input.onCancel}>
                <T context="verb, stops a thread waiting for room">Cancel</T>
              </Button>
            </>
          ),
        }),
  };
}
