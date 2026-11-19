import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";

import { shortcutLabelForCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Opens triage from the Needs you header. */
export function NeedsYouTriageButton() {
  const navigate = useNavigate();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcutLabel = shortcutLabelForCommand(keybindings, "needsYou.triage");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="micro"
            variant="ghost"
            data-testid="sidebar-needs-you-triage"
            onClick={() => void navigate({ to: "/triage" })}
          />
        }
      >
        Triage
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        Go through them one by one{shortcutLabel ? ` (${shortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}
