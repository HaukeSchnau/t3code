import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  ProjectId,
  ThreadAskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { HtmlRenderId } from "./htmlRender.ts";

/** The page index (patches/needs-you.md): pages shown with `html_render`, newest first. */
export const HTML_RENDER_PAGE_LIST_MAX_LIMIT = 200;

export const HtmlRenderPageFilter = Schema.Literals(["asks", "unseen", "all"]);
export type HtmlRenderPageFilter = typeof HtmlRenderPageFilter.Type;

export const HtmlRenderPage = Schema.Struct({
  renderId: HtmlRenderId,
  threadId: ThreadId,
  projectId: ProjectId,
  threadTitle: Schema.String,
  title: Schema.String,
  /** The attachment id of the newest version. */
  latestAttachmentId: HtmlRenderId,
  firstPublishedAt: IsoDateTime,
  latestPublishedAt: IsoDateTime,
  versionCount: Schema.Int,
  /** When a reader last saw the newest version; a new version clears it. */
  seenAt: Schema.NullOr(IsoDateTime),
  /** The page's open ask, if it waits for the reader. */
  ask: Schema.NullOr(
    Schema.Struct({ id: ThreadAskId, text: Schema.String, raisedAt: IsoDateTime }),
  ),
});
export type HtmlRenderPage = typeof HtmlRenderPage.Type;

export const HtmlRenderListPagesInput = Schema.Struct({
  /** One thread's pages, waiting ones first; without it, every thread's. */
  threadId: Schema.optional(ThreadId),
  filter: HtmlRenderPageFilter,
  /** `nextCursor` of the previous page of results. */
  cursor: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: HTML_RENDER_PAGE_LIST_MAX_LIMIT })),
  ),
});
export type HtmlRenderListPagesInput = typeof HtmlRenderListPagesInput.Type;

export const HtmlRenderPageList = Schema.Struct({
  pages: Schema.Array(HtmlRenderPage),
  nextCursor: Schema.NullOr(Schema.String),
});
export type HtmlRenderPageList = typeof HtmlRenderPageList.Type;

export const HtmlRenderMarkSeenInput = Schema.Struct({
  threadId: ThreadId,
  renderId: HtmlRenderId,
  /** The version the reader saw; an older one than the newest marks nothing. */
  attachmentId: HtmlRenderId,
});
export type HtmlRenderMarkSeenInput = typeof HtmlRenderMarkSeenInput.Type;

export const HtmlRenderPageChangesInput = Schema.Struct({
  /** One thread's pages; without it, every thread's. */
  threadId: Schema.optional(ThreadId),
});
export type HtmlRenderPageChangesInput = typeof HtmlRenderPageChangesInput.Type;

/**
 * Sent on subscribe and whenever a page in scope is published or seen, or its thread's asks,
 * title or deletion change what a list shows. `revision` counts the changes since subscribing.
 */
export const HtmlRenderPageChange = Schema.Struct({ revision: Schema.Int, pages: Schema.Int });
export type HtmlRenderPageChange = typeof HtmlRenderPageChange.Type;

export class HtmlRenderPagesError extends Schema.TaggedError<HtmlRenderPagesError>()(
  "HtmlRenderPagesError",
  { cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "Pages could not be loaded.";
  }
}
