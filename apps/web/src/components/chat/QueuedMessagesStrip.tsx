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
      aria-label={`Queued messages (${queuedMessages.length})`}
      data-queued-messages-strip="true"
      role="list"
      className={cn(
        "relative z-0 mx-auto -mb-5 flex max-h-48 w-[calc(100%-1.5rem)] max-w-[48rem] flex-col gap-1 overflow-y-auto rounded-[18px] border border-border/60 bg-card/90 px-3 py-3 pb-8 shadow-sm sm:w-[calc(100%-4rem)] sm:px-5",
        className,
      )}
    >
      {queuedMessages.map((message) => {
        const messageLabel = message.text.trim() || "Image";

        return (
          <div
            key={message.messageId}
            role="listitem"
            className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-2 py-1.5 text-muted-foreground transition-colors hover:bg-muted/30 sm:px-2.5"
          >
            <CornerDownRightIcon className="size-4 text-muted-foreground/60" />
            <div className="min-w-0">
              <div className="truncate text-sm text-foreground/75">{message.text || "Image"}</div>
              {message.attachments.length > 0 ? (
                <div className="truncate text-xs text-muted-foreground">
                  {message.attachments.length} attachment
                  {message.attachments.length === 1 ? "" : "s"}
                </div>
              ) : null}
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                size="xs"
                variant="ghost"
                aria-label={`${isRunning ? "Send queued message now" : "Send queued message"}: ${messageLabel}`}
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
                aria-label={`Remove queued message: ${messageLabel}`}
                className="text-muted-foreground hover:text-foreground"
                onClick={() => onDelete(message)}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
});
