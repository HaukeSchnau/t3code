import { useAtomValue } from "@effect/atom-react";
import { groupHtmlRenderPages } from "@t3tools/client-runtime/state/html-render";
import {
  HTML_RENDER_PAGE_LIST_MAX_LIMIT,
  type HtmlRenderPage,
  type OrchestrationMessageContext,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { AppWindowIcon } from "lucide-react";
import { useState } from "react";

import { useThreadShell } from "~/state/entities";
import { htmlRenderEnvironment } from "~/state/htmlRender";
import { useEnvironmentQuery } from "~/state/query";

import { PageListRow } from "../pages/PageListRow";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Skeleton } from "../ui/skeleton";
import { HtmlRenderPageDialog } from "./HtmlRenderPageDialog";

const GROUPS = [
  { key: "asks", label: "Waiting for you" },
  { key: "unseen", label: "New" },
  { key: "seen", label: "Seen" },
] as const;

/**
 * The thread's pages in its header. A page the loaded timeline holds scrolls into view; an older
 * one opens full screen. The closed chip reads only counts; the list loads when it opens.
 */
export function ThreadPagesControl(props: {
  readonly threadRef: ScopedThreadRef;
  /** Scrolls to the page; false when the loaded timeline does not hold it. */
  readonly onRevealPage: (renderId: string) => boolean;
  readonly onSendMessage:
    | ((text: string, context: OrchestrationMessageContext) => Promise<void>)
    | undefined;
}) {
  const { threadRef } = props;
  const count = useAtomValue(htmlRenderEnvironment.threadPageCount(threadRef));
  const asks =
    useThreadShell(threadRef)?.openAsks?.filter((ask) => ask.source.type === "page").length ?? 0;
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<HtmlRenderPage | null>(null);
  if (count === null || count === 0) return null;
  const label = count === 1 ? "1 page" : `${count} pages`;
  const openPage = (page: HtmlRenderPage) => {
    setOpen(false);
    if (props.onRevealPage(page.renderId)) return;
    setDialog(page);
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              size="xs"
              variant="ghost-muted"
              aria-label={
                asks > 0 ? `${label}, ${asks} waiting for you` : `${label} in this thread`
              }
            />
          }
        >
          <AppWindowIcon aria-hidden />
          <span className="tabular-nums">{label}</span>
          {asks > 0 ? (
            <Badge variant="warning" size="sm">
              {asks} waiting
            </Badge>
          ) : null}
        </PopoverTrigger>
        <PopoverPopup width="md" padding="compact" align="end">
          <ThreadPagesList threadRef={threadRef} onOpen={openPage} />
        </PopoverPopup>
      </Popover>
      {dialog !== null ? (
        <HtmlRenderPageDialog
          environmentId={threadRef.environmentId}
          threadRef={threadRef}
          page={dialog}
          onSendMessage={props.onSendMessage}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </>
  );
}

/** Mounted only while the popover is open, so a closed chip loads no rows. */
function ThreadPagesList(props: {
  readonly threadRef: ScopedThreadRef;
  readonly onOpen: (page: HtmlRenderPage) => void;
}) {
  const pages = useEnvironmentQuery(
    htmlRenderEnvironment.pages({
      environmentId: props.threadRef.environmentId,
      input: {
        threadId: props.threadRef.threadId,
        filter: "all",
        limit: HTML_RENDER_PAGE_LIST_MAX_LIMIT,
      },
    }),
  ).data;
  if (pages === null) {
    return (
      <div className="flex flex-col gap-2 px-3 py-1">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  const groups = groupHtmlRenderPages(pages.pages);
  return (
    <div className="flex max-h-[min(28rem,70vh)] flex-col gap-3 overflow-y-auto">
      {GROUPS.map((group) =>
        groups[group.key].length === 0 ? null : (
          <section key={group.key} className="flex flex-col gap-0.5">
            <h3 className="px-3 pb-1 text-xs font-medium text-muted-foreground/70">
              {group.label}
            </h3>
            {groups[group.key].map((page) => (
              <PageListRow key={page.renderId} page={page} onOpen={props.onOpen} />
            ))}
          </section>
        ),
      )}
    </div>
  );
}
