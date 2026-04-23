import { memo, useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowDownToLineIcon,
  EyeIcon,
  NotebookPenIcon,
  PanelRightCloseIcon,
  PencilIcon,
  ScissorsLineDashedIcon,
} from "lucide-react";
import ChatMarkdown from "./ChatMarkdown";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Toggle, ToggleGroup } from "./ui/toggle-group";
import { cn } from "~/lib/utils";

interface ScratchpadPanelProps {
  scratchpad: string;
  markdownCwd: string | undefined;
  mode?: "sheet" | "sidebar";
  onScratchpadChange: (value: string) => void;
  onAppendToComposer: (text: string) => void;
  onClose: () => void;
}

const ScratchpadPanel = memo(function ScratchpadPanel({
  scratchpad,
  markdownCwd,
  mode = "sidebar",
  onScratchpadChange,
  onAppendToComposer,
  onClose,
}: ScratchpadPanelProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [viewMode, setViewMode] = useState<"write" | "preview">("write");
  const scratchpadEmpty = scratchpad.trim().length === 0;
  const selectionStart = Math.max(0, Math.min(selection.start, scratchpad.length));
  const selectionEnd = Math.max(0, Math.min(selection.end, scratchpad.length));
  const selectedText = useMemo(() => {
    if (selectionStart === selectionEnd) {
      return "";
    }
    return scratchpad.slice(
      Math.min(selectionStart, selectionEnd),
      Math.max(selectionStart, selectionEnd),
    );
  }, [scratchpad, selectionEnd, selectionStart]);
  const selectedTextEmpty = selectedText.trim().length === 0;

  const updateSelection = useCallback((target: HTMLTextAreaElement) => {
    setSelection({
      start: target.selectionStart ?? 0,
      end: target.selectionEnd ?? 0,
    });
  }, []);

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
          <ToggleGroup
            size="xs"
            variant="outline"
            value={[viewMode]}
            onValueChange={(value) => {
              const nextValue = value[0];
              if (nextValue === "write" || nextValue === "preview") {
                setViewMode(nextValue);
              }
            }}
          >
            <Toggle
              value="write"
              aria-label="Show scratchpad editor"
              data-testid="scratchpad-write-toggle"
            >
              <PencilIcon className="size-3" />
              <span>Write</span>
            </Toggle>
            <Toggle
              value="preview"
              aria-label="Show scratchpad markdown preview"
              data-testid="scratchpad-preview-toggle"
            >
              <EyeIcon className="size-3" />
              <span>Preview</span>
            </Toggle>
          </ToggleGroup>

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

        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground/70">
          <Badge
            variant={selectedTextEmpty ? "outline" : "secondary"}
            size="sm"
            className={cn(
              "rounded-md px-1.5 normal-case",
              selectedTextEmpty ? "bg-transparent" : "bg-secondary/80",
            )}
            data-testid="scratchpad-selection-status"
          >
            {selectedTextEmpty
              ? "Highlight text to append a selection"
              : `${selectedText.trim().length} selected`}
          </Badge>
          <span>Shortcut</span>
          <Badge
            variant="outline"
            size="sm"
            className="rounded-md border-border/70 bg-background/70 px-1.5 font-mono text-[10px]"
          >
            Mod+Shift+Enter
          </Badge>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col p-3">
        {viewMode === "write" ? (
          <Textarea
            ref={textareaRef}
            value={scratchpad}
            onChange={(event) => {
              onScratchpadChange(event.target.value);
              updateSelection(event.target);
            }}
            onSelect={(event) => updateSelection(event.currentTarget)}
            onKeyUp={(event) => updateSelection(event.currentTarget)}
            onMouseUp={(event) => updateSelection(event.currentTarget)}
            onKeyDown={handleShortcut}
            placeholder="Jot notes, ideas, or reminders. Markdown is supported in preview. Nothing here is sent unless you append it to the composer."
            className="flex min-h-0 flex-1 rounded-lg border-border/70 bg-background/80 shadow-none"
            data-testid="scratchpad-textarea"
          />
        ) : (
          <div
            className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border/70 bg-background/80 px-3 py-2"
            data-testid="scratchpad-preview"
          >
            {scratchpad.trim().length > 0 ? (
              <ChatMarkdown text={scratchpad} cwd={markdownCwd} />
            ) : (
              <p className="text-sm text-muted-foreground/70">
                Markdown preview appears here once you start writing.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

export default ScratchpadPanel;
