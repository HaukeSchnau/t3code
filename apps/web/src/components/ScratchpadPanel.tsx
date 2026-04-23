import { memo, useCallback, useRef, type KeyboardEvent } from "react";
import {
  ArrowDownToLineIcon,
  NotebookPenIcon,
  PanelRightCloseIcon,
  ScissorsLineDashedIcon,
} from "lucide-react";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { cn } from "~/lib/utils";

interface ScratchpadPanelProps {
  scratchpad: string;
  mode?: "sheet" | "sidebar";
  onScratchpadChange: (value: string) => void;
  onAppendToComposer: (text: string) => void;
  onClose: () => void;
}

const ScratchpadPanel = memo(function ScratchpadPanel({
  scratchpad,
  mode = "sidebar",
  onScratchpadChange,
  onAppendToComposer,
  onClose,
}: ScratchpadPanelProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const scratchpadEmpty = scratchpad.trim().length === 0;

  const appendAll = useCallback(() => {
    if (scratchpadEmpty) {
      return;
    }
    onAppendToComposer(scratchpad);
  }, [onAppendToComposer, scratchpad, scratchpadEmpty]);

  const readSelectedText = useCallback(() => {
    const target = textareaRef.current;
    if (!target) {
      return "";
    }
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? 0;
    if (start === end) {
      return "";
    }
    return scratchpad.slice(Math.min(start, end), Math.max(start, end));
  }, [scratchpad]);

  const appendSelection = useCallback(() => {
    const nextSelectedText = readSelectedText();
    if (nextSelectedText.trim().length === 0) {
      return;
    }
    onAppendToComposer(nextSelectedText);
  }, [onAppendToComposer, readSelectedText]);

  const handleShortcut = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === "Enter") {
        const nextSelectedText = scratchpad.slice(
          Math.min(event.currentTarget.selectionStart ?? 0, event.currentTarget.selectionEnd ?? 0),
          Math.max(event.currentTarget.selectionStart ?? 0, event.currentTarget.selectionEnd ?? 0),
        );
        if (nextSelectedText.trim().length === 0) {
          return;
        }
        event.preventDefault();
        onAppendToComposer(nextSelectedText);
      }
    },
    [onAppendToComposer, scratchpad],
  );

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col bg-card/35",
        mode === "sidebar"
          ? "h-full w-[340px] shrink-0 border-l border-border/70"
          : "h-full w-full",
      )}
      data-testid="scratchpad-panel"
    >
      <div className="shrink-0 border-b border-border/60 px-3 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background/80 text-muted-foreground shadow-xs/5">
                <NotebookPenIcon className="size-3.5" />
              </span>
              <div className="min-w-0">
                <h2 className="truncate font-medium text-[13px] leading-5">Scratchpad</h2>
                <p className="text-[11px] text-muted-foreground/70">Private to this thread</p>
              </div>
            </div>
          </div>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onClose}
            aria-label="Close scratchpad"
            className="mt-0.5 shrink-0 text-muted-foreground/50 hover:text-foreground/70"
          >
            <PanelRightCloseIcon className="size-3.5" />
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={appendSelection}
              disabled={scratchpadEmpty}
              data-testid="scratchpad-append-selection"
              aria-label="Append selected scratchpad text to composer"
            >
              <ScissorsLineDashedIcon className="size-3" />
              <span>Selection</span>
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={appendAll}
              disabled={scratchpadEmpty}
              data-testid="scratchpad-append-all"
              aria-label="Append scratchpad to composer"
            >
              <ArrowDownToLineIcon className="size-3" />
              <span>All</span>
            </Button>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col p-3">
        <Textarea
          ref={textareaRef}
          value={scratchpad}
          onChange={(event) => onScratchpadChange(event.target.value)}
          onKeyDown={handleShortcut}
          placeholder="Jot notes, ideas, or reminders. Nothing here is sent unless you append it to the composer."
          className="flex min-h-0 flex-1 rounded-lg border-border/70 bg-background/80 shadow-none"
          data-testid="scratchpad-textarea"
        />
      </div>
    </div>
  );
});

export default ScratchpadPanel;
