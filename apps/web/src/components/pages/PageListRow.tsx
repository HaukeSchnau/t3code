import type { HtmlRenderPage } from "@t3tools/contracts";
import { MessageCircleQuestionIcon, MessagesSquareIcon } from "lucide-react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** One page in a page list: its ask when it waits for the reader, else when it last changed. */
export function PageListRow(props: {
  readonly page: HtmlRenderPage;
  /** The thread's title, for lists that span threads. */
  readonly showThread?: boolean;
  readonly onOpen: (page: HtmlRenderPage) => void;
  readonly onOpenThread?: (page: HtmlRenderPage) => void;
}) {
  const { page, onOpenThread } = props;
  const nowMinute = useNowMinute();
  const when = formatRelativeTimeLabel(page.latestPublishedAt, Date.parse(`${nowMinute}:00.000Z`));
  const details = [
    props.showThread ? page.threadTitle : null,
    when,
    page.versionCount > 1 ? `${page.versionCount} versions` : null,
  ].filter((part) => part !== null && part !== "");
  return (
    <div className="group/page-row flex min-w-0 items-start gap-1 rounded-md transition-colors hover:bg-accent/60">
      <button
        type="button"
        onClick={() => props.onOpen(page)}
        className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 rounded-md px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{page.title}</span>
          {page.ask === null && page.seenAt === null ? (
            <Badge variant="info" size="sm">
              New
            </Badge>
          ) : null}
        </span>
        {page.ask !== null ? (
          <span className="flex min-w-0 items-start gap-1.5 text-xs text-foreground">
            <MessageCircleQuestionIcon
              aria-hidden
              className="mt-px size-3.5 shrink-0 text-warning"
            />
            <span className="line-clamp-2 min-w-0">{page.ask.text}</span>
          </span>
        ) : null}
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {details.join(" · ")}
        </span>
      </button>
      {onOpenThread !== undefined ? (
        <div className="mt-2 me-2 opacity-0 group-hover/page-row:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={`Open the thread ${page.threadTitle}`}
                  size="icon-xs"
                  variant="ghost-muted"
                  onClick={() => onOpenThread(page)}
                />
              }
            >
              <MessagesSquareIcon />
            </TooltipTrigger>
            <TooltipPopup side="left">Open thread</TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
}
