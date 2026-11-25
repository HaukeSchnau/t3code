import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { T, Var } from "gt-react";

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
        <T>Triage</T>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {shortcutLabel ? (
          <T>
            Go through them one by one (<Var>{shortcutLabel}</Var>)
          </T>
        ) : (
          <T>Go through them one by one</T>
        )}
      </TooltipPopup>
    </Tooltip>
  );
}
