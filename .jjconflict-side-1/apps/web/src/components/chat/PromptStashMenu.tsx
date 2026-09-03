import { memo } from "react";
import { ArchiveIcon, ArchiveRestoreIcon, CopyCheckIcon, Trash2Icon } from "lucide-react";
import type { PromptStash, PromptStashId } from "../../composerDraftStore";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator as MenuDivider, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function promptPreview(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length > 0 ? compact : "Untitled prompt";
}

function formatStashTime(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return "Unknown time";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatStashMeta(stash: PromptStash): string {
  const parts = [formatStashTime(stash.createdAt)];
  if (stash.draft.interactionMode) {
    parts.push(stash.draft.interactionMode === "plan" ? "Plan" : "Chat");
  }
  if (stash.draft.runtimeMode) {
    parts.push(stash.draft.runtimeMode);
  }
  return parts.join(" · ");
}

export const PromptStashMenu = memo(function PromptStashMenu(props: {
  stashes: PromptStash[];
  canStashCurrent: boolean;
  disabled?: boolean;
  onStashCurrent: () => void;
  onApply: (stashId: PromptStashId) => void;
  onPop: (stashId: PromptStashId) => void;
  onDrop: (stashId: PromptStashId) => void;
}) {
  if (props.stashes.length === 0 && !props.canStashCurrent) {
    return null;
  }

  const disabled = props.disabled === true;

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="relative shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
                  disabled={disabled}
                  aria-label="Prompt stash"
                />
              }
            />
          }
        >
          <ArchiveIcon aria-hidden="true" className="size-4" />
          {props.stashes.length > 0 ? (
            <span className="-right-0.5 -top-0.5 absolute flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] text-primary-foreground leading-4">
              {props.stashes.length}
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="top">Prompt stash</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="top" className="w-80">
        <MenuItem disabled={!props.canStashCurrent || disabled} onClick={props.onStashCurrent}>
          <ArchiveIcon className="size-4 shrink-0" />
          Stash current prompt
        </MenuItem>
        <MenuDivider />
        {props.stashes.length === 0 ? (
          <div className="px-2 py-3 text-muted-foreground text-sm">No stashed prompts</div>
        ) : (
          <div className="space-y-1">
            {props.stashes.map((stash) => (
              <div
                key={stash.id}
                className="rounded-md border border-border/60 bg-background/50 p-2"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium text-sm">
                    {promptPreview(stash.draft.prompt)}
                  </div>
                  <div className="truncate text-muted-foreground text-xs">
                    {formatStashMeta(stash)}
                  </div>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-1">
                  <MenuItem
                    className="inline-flex h-7 items-center justify-center gap-1 rounded-sm px-2 text-xs hover:bg-accent hover:text-accent-foreground"
                    onClick={() => props.onApply(stash.id)}
                  >
                    <CopyCheckIcon className="size-3.5" />
                    Apply
                  </MenuItem>
                  <MenuItem
                    className="inline-flex h-7 items-center justify-center gap-1 rounded-sm px-2 text-xs hover:bg-accent hover:text-accent-foreground"
                    onClick={() => props.onPop(stash.id)}
                  >
                    <ArchiveRestoreIcon className="size-3.5" />
                    Pop
                  </MenuItem>
                  <MenuItem
                    variant="destructive"
                    className={cn(
                      "inline-flex h-7 items-center justify-center gap-1 rounded-sm px-2 text-xs",
                      "text-destructive hover:bg-destructive/10 hover:text-destructive",
                    )}
                    onClick={() => props.onDrop(stash.id)}
                  >
                    <Trash2Icon className="size-3.5" />
                    Drop
                  </MenuItem>
                </div>
              </div>
            ))}
          </div>
        )}
      </MenuPopup>
    </Menu>
  );
});
