import { memo, useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { EyeIcon, PanelRightCloseIcon, PencilIcon } from "lucide-react";
import ChatMarkdown from "./ChatMarkdown";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Kbd, KbdGroup } from "./ui/kbd";
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
            onClick={appendSelection}
            disabled={scratchpadEmpty}
            data-testid="scratchpad-append-selection"
            aria-label="Append selected scratchpad text to composer"
          >
            Selection
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
            All
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

      <div className="flex min-h-0 shrink-0 items-center justify-between border-b border-border/50 px-3 py-2">
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

        <div className="flex items-center gap-2 text-[11px] text-muted-foreground/70">
          {selectedTextEmpty ? (
            <span>Select text to append part of the note.</span>
          ) : (
            <span data-testid="scratchpad-selection-status">
              {selectedText.trim().length} selected
            </span>
          )}
          <KbdGroup className="hidden sm:inline-flex">
            <Kbd>Mod</Kbd>
            <Kbd>Shift</Kbd>
            <Kbd>Enter</Kbd>
          </KbdGroup>
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
            className="flex min-h-0 flex-1"
            data-testid="scratchpad-textarea"
          />
        ) : (
          <div
            className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border/60 bg-background/70 px-3 py-2"
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
