import { memo } from "react";
import { CornerDownRightIcon, Trash2Icon } from "lucide-react";
import type { QueuedMessage } from "~/types";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

const ACTION_LABEL_MAX_LENGTH = 96;

function actionLabelForQueuedMessage(message: QueuedMessage): string {
  const label = message.text.trim() || "Image";

  if (label.length <= ACTION_LABEL_MAX_LENGTH) {
    return label;
  }

  return `${label.slice(0, ACTION_LABEL_MAX_LENGTH - 3)}...`;
}

interface QueuedMessagesStripProps {
  queuedMessages: ReadonlyArray<QueuedMessage>;
  isRunning: boolean;
  density?: "default" | "compact";
  className?: string;
  onDispatch: (message: QueuedMessage) => void;
  onDelete: (message: QueuedMessage) => void;
}

export const QueuedMessagesStrip = memo(function QueuedMessagesStrip({
  queuedMessages,
  isRunning,
  density = "default",
  className,
  onDispatch,
  onDelete,
}: QueuedMessagesStripProps) {
  if (queuedMessages.length === 0) {
    return null;
  }

  return (
    <div
      aria-label={`Messages queued remotely (${queuedMessages.length})`}
      data-queued-messages-strip="true"
      role="list"
      className={cn(
        "relative z-0 mx-auto flex max-h-48 w-full flex-col gap-1 overflow-y-auto rounded-[18px] border border-border bg-popover text-popover-foreground shadow-xs/5 not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[17px] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
        density === "default"
          ? "mb-2 max-w-3xl px-2 py-2 sm:px-2.5"
          : "mb-1.5 max-w-none rounded-xl px-1.5 py-1.5 before:rounded-[11px]",
        className,
      )}
    >
      <div className="relative z-0 flex items-center justify-between gap-3 px-2 pb-0.5 text-[11px] font-medium text-muted-foreground">
        <span>Queued remotely</span>
        <span className="tabular-nums">
          {queuedMessages.length} message{queuedMessages.length === 1 ? "" : "s"}
        </span>
      </div>
      {queuedMessages.map((message) => {
        const messageLabel = actionLabelForQueuedMessage(message);

        return (
          <div
            key={message.messageId}
            role="listitem"
            className={cn(
              "group relative z-0 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/50",
              density === "default" ? "min-h-10 gap-3 px-2 py-1.5 sm:px-2.5" : "gap-2 px-1.5 py-1",
            )}
          >
            <span
              className={cn(
                "flex shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground",
                density === "default" ? "size-6" : "size-5",
              )}
            >
              <CornerDownRightIcon className={cn(density === "default" ? "size-3.5" : "size-3")} />
            </span>
            <div className="min-w-0">
              <div
                className={cn(
                  "truncate font-medium text-foreground",
                  density === "default" ? "text-sm" : "text-xs",
                )}
              >
                {message.text || "Image"}
              </div>
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
                className={cn(
                  "text-muted-foreground hover:text-foreground",
                  density === "compact" && "px-1.5",
                )}
                onClick={() => onDispatch(message)}
              >
                <CornerDownRightIcon className="size-3.5" />
                <span className={cn(density === "default" ? "hidden sm:inline" : "sr-only")}>
                  Send now
                </span>
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
