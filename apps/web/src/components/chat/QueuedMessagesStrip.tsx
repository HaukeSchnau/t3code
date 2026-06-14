import { memo } from "react";
import { SendIcon, XIcon } from "lucide-react";
import type { QueuedMessage } from "~/types";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

interface QueuedMessagesStripProps {
  queuedMessages: ReadonlyArray<QueuedMessage>;
  isRunning: boolean;
  className?: string;
  onDispatch: (message: QueuedMessage) => void;
  onDelete: (message: QueuedMessage) => void;
}

export const QueuedMessagesStrip = memo(function QueuedMessagesStrip({
  queuedMessages,
  isRunning,
  className,
  onDispatch,
  onDelete,
}: QueuedMessagesStripProps) {
  if (queuedMessages.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "mx-auto mb-2 flex max-h-36 w-full max-w-208 flex-col gap-1.5 overflow-y-auto rounded-md border border-border/70 bg-background/95 p-2 shadow-sm",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3 px-1">
        <span className="text-xs font-medium text-muted-foreground">
          Queue ({queuedMessages.length})
        </span>
      </div>
      {queuedMessages.map((message) => (
        <div
          key={message.messageId}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md bg-muted/45 px-2 py-1.5"
        >
          <div className="min-w-0">
            <div className="truncate text-sm text-foreground">{message.text || "Image"}</div>
            {message.attachments.length > 0 ? (
              <div className="truncate text-xs text-muted-foreground">
                {message.attachments.length} attachment{message.attachments.length === 1 ? "" : "s"}
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={isRunning ? "Send queued message now" : "Send queued message"}
              onClick={() => onDispatch(message)}
            >
              <SendIcon className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Remove queued message"
              onClick={() => onDelete(message)}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
});
