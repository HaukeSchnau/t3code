import {
  HTML_RENDER_PAGE_LIST_MAX_LIMIT,
  type EnvironmentId,
  type HtmlRenderPage,
  type ThreadId,
} from "@t3tools/contracts";
import { htmlRenderFileName } from "@t3tools/shared/htmlRender";

import { htmlRenderEnvironment } from "../../state/htmlRender";
import { useEnvironmentQuery } from "../../state/query";

/** One thread's pages, for its Pages sheet. */
export function useThreadPages(
  target: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null,
) {
  return useEnvironmentQuery(
    target === null
      ? null
      : htmlRenderEnvironment.pages({
          environmentId: target.environmentId,
          input: {
            threadId: target.threadId,
            filter: "all",
            limit: HTML_RENDER_PAGE_LIST_MAX_LIMIT,
          },
        }),
  );
}

export function threadPagesLabel(count: number) {
  return count === 1 ? "1 page" : `${count} pages`;
}

/** The full-screen route of a page's newest version, which keeps the bridge it answers through. */
export function htmlRenderPageRoute(environmentId: EnvironmentId, page: HtmlRenderPage) {
  return {
    environmentId: String(environmentId),
    threadId: String(page.threadId),
    attachmentId: page.latestAttachmentId,
    name: htmlRenderFileName(page.title),
    mimeType: "text/html",
    sizeBytes: "0",
    htmlRender: "1",
    renderId: page.renderId,
  } as const;
}
