import { memo } from "react";
import { CornerDownRightIcon, Trash2Icon } from "lucide-react";
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
      data-queued-messages-strip="true"
      className={cn(
        "relative z-0 mx-auto -mb-3 flex max-h-48 w-full max-w-208 flex-col gap-2 overflow-y-auto rounded-[20px] border border-border/70 bg-card/95 p-3 pb-6 shadow-sm",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3 px-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          Queue ({queuedMessages.length})
        </span>
      </div>
      {queuedMessages.map((message) => (
        <div
          key={message.messageId}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-xl bg-muted/35 px-3 py-2.5"
        >
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">
              {message.text || "Image"}
            </div>
            {message.attachments.length > 0 ? (
              <div className="truncate text-xs text-muted-foreground">
                {message.attachments.length} attachment{message.attachments.length === 1 ? "" : "s"}
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-label={isRunning ? "Send queued message now" : "Send queued message"}
              className="text-muted-foreground hover:text-foreground"
              onClick={() => onDispatch(message)}
            >
              <CornerDownRightIcon className="size-3.5" />
              <span className="hidden sm:inline">Steer</span>
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Remove queued message"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => onDelete(message)}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
});
