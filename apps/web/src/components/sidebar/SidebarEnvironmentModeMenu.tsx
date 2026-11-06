import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronsUpDownIcon } from "lucide-react";

import { environmentModeLabel } from "@t3tools/client-runtime/connection";

import { applyEnvironmentMode, useEnvironmentModes } from "~/connection/environmentModes";
import { shortcutLabelForCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "../ui/menu";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";

const ALL_VALUE = "all";

export function SidebarEnvironmentModeMenu() {
  const navigate = useNavigate();
  const { modes, active, activeLabel } = useEnvironmentModes();
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "environments.cycleMode",
  );
  if (modes.length === 0) return null;

  return (
    <SidebarMenuItem className="min-w-0 shrink">
      <Menu>
        <MenuTrigger
          render={<SidebarMenuButton size="sm" aria-label={`Environment mode: ${activeLabel}`} />}
        >
          <span className="truncate">{activeLabel}</span>
          <ChevronsUpDownIcon />
        </MenuTrigger>
        <MenuPopup side="top" align="start">
          <MenuRadioGroup
            value={active === null ? ALL_VALUE : active}
            onValueChange={(value: string) =>
              void applyEnvironmentMode(value === ALL_VALUE ? null : value)
            }
          >
            {modes.map((mode) => (
              <MenuRadioItem key={mode.id} value={mode.id} closeOnClick>
                <span className="flex items-center justify-between gap-3">
                  {mode.name}
                  <MenuRadioItemIndicator />
                </span>
              </MenuRadioItem>
            ))}
            <MenuRadioItem value={ALL_VALUE} closeOnClick>
              <span className="flex items-center justify-between gap-3">
                {environmentModeLabel(modes, null)}
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuItem
            onClick={() =>
              void navigate({ to: "/settings/connections", hash: "environment-modes" })
            }
          >
            Edit modes
            {shortcutLabel ? <MenuShortcut>Cycle {shortcutLabel}</MenuShortcut> : null}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </SidebarMenuItem>
  );
}
