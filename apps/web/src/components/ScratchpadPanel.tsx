import { memo } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { cn } from "~/lib/utils";
import { PanelRightCloseIcon } from "lucide-react";

interface ScratchpadPanelProps {
  scratchpad: string;
  mode?: "sheet" | "sidebar";
  onScratchpadChange: (value: string) => void;
  onAppendToComposer: () => void;
  onClose: () => void;
}

const ScratchpadPanel = memo(function ScratchpadPanel({
  scratchpad,
  mode = "sidebar",
  onScratchpadChange,
  onAppendToComposer,
  onClose,
}: ScratchpadPanelProps) {
  const scratchpadEmpty = scratchpad.trim().length === 0;

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col bg-card/50",
        mode === "sidebar"
          ? "h-full w-[340px] shrink-0 border-l border-border/70"
          : "h-full w-full",
      )}
      data-testid="scratchpad-panel"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <div className="flex items-center gap-2">
          <Badge
            variant="secondary"
            className="rounded-md bg-muted/60 px-1.5 py-0 text-[10px] font-semibold tracking-wide uppercase"
          >
            Scratchpad
          </Badge>
          <span className="text-[11px] text-muted-foreground/60">Private to this thread</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={onAppendToComposer}
            disabled={scratchpadEmpty}
            data-testid="scratchpad-append"
            aria-label="Append scratchpad to composer"
          >
            Append
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onClose}
            aria-label="Close scratchpad"
            className="text-muted-foreground/50 hover:text-foreground/70"
          >
            <PanelRightCloseIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col p-3">
        <Textarea
          value={scratchpad}
          onChange={(event) => onScratchpadChange(event.target.value)}
          placeholder="Jot notes, ideas, or reminders. Nothing here is sent unless you append it to the composer."
          className="flex min-h-0 flex-1"
          data-testid="scratchpad-textarea"
        />
      </div>
    </div>
  );
});

export default ScratchpadPanel;
