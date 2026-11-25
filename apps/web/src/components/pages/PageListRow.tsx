import type { HtmlRenderPage } from "@t3tools/contracts";
import { MessageCircleQuestionIcon, MessagesSquareIcon } from "lucide-react";
import { T, useGT, useMessages } from "gt-react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Badge } from "../ui/badge";
import { Button, ContentButton } from "../ui/button";
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
  const gt = useGT();
  const m = useMessages();
  const nowMinute = useNowMinute();
  const when = formatRelativeTimeLabel(
    page.latestPublishedAt,
    Date.parse(`${nowMinute}:00.000Z`),
    m,
  );
  return (
    <div className="group/page-row flex min-w-0 items-start gap-1 rounded-row transition-colors hover:surface-ghost-hover">
      <ContentButton
        className="group/page block min-w-0 flex-1 cursor-pointer text-left"
        onClick={() => props.onOpen(page)}
      >
        <span className="flex w-full flex-col gap-0.5 rounded-row px-3 py-2 group-focus-visible/page:ring-2 group-focus-visible/page:ring-ring/70 group-focus-visible/page:ring-inset">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-label">{page.title}</span>
            {page.ask === null && page.seenAt === null ? (
              <Badge variant="info" size="sm">
                <T context="badge, a page not seen yet">New</T>
              </Badge>
            ) : null}
          </span>
          {page.ask !== null ? (
            <span className="flex min-w-0 items-start gap-1.5 text-meta text-foreground">
              <MessageCircleQuestionIcon
                aria-hidden
                className="mt-px size-3.5 shrink-0 text-warning"
              />
              <span className="line-clamp-2 min-w-0">{page.ask.text}</span>
            </span>
          ) : null}
          <span className="flex min-w-0 gap-2 text-meta text-muted-foreground">
            {props.showThread ? (
              <span className="min-w-0 flex-1 truncate">{page.threadTitle}</span>
            ) : null}
            {when === "" ? null : <span className="shrink-0">{when}</span>}
            {page.versionCount > 1 ? (
              <span className="shrink-0 tabular-nums">
                {gt("{count, plural, one {{count} version} other {{count} versions}}", {
                  count: page.versionCount,
                })}
              </span>
            ) : null}
          </span>
        </span>
      </ContentButton>
      {onOpenThread !== undefined ? (
        <div className="mt-2 me-2 opacity-0 group-hover/page-row:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={gt("Open the thread {title}", { title: page.threadTitle })}
                  size="icon-xs"
                  variant="ghost-muted"
                  onClick={() => onOpenThread(page)}
                />
              }
            >
              <MessagesSquareIcon />
            </TooltipTrigger>
            <TooltipPopup side="left">
              <T>Open thread</T>
            </TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
}
