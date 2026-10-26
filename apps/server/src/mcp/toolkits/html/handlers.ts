import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { attachmentBelongsToThread } from "../../../attachmentStore.ts";
import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { HtmlPreviewToolkit, HtmlRenderToolkit, type HtmlToolkit } from "./tools.ts";

const INVALID_PAGE_ERRORS = new Set([
  "HtmlRenderImagesNotFoundError",
  "HtmlRenderImageTooLargeError",
  "HtmlRenderPageSourceError",
  "HtmlRenderPageTooLargeError",
  "HtmlRenderViewportHeightError",
]);

const toFailure = (error: { readonly _tag: string; readonly message: string }) =>
  new OrchestratorMcpFailure({
    code: INVALID_PAGE_ERRORS.has(error._tag) ? "invalid_request" : "orchestration_error",
    message: error.message,
  });

const SHOWN_MESSAGE =
  "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.";

const handlers = {
  // Local-file access limits this host browser to T3-launched agents.
  html_preview: McpToolAccess.readsAsCaller(({ html, path, ...input }) =>
    Effect.gen(function* () {
      const htmlRender = yield* HtmlRender.HtmlRender;
      const page = yield* htmlRender.loadPage({ html, path }).pipe(Effect.mapError(toFailure));
      const { png, ...preview } = yield* htmlRender
        .preview({ ...input, html: page })
        .pipe(Effect.mapError(toFailure));
      return {
        ...preview,
        screenshot: {
          mimeType: "image/png" as const,
          data: png,
          width: preview.width,
          height: preview.capturedHeight,
        },
      };
    }),
  ),
  html_render: McpToolAccess.actsAsCaller(({ html, path, ...input }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "html_render");
      const htmlRender = yield* HtmlRender.HtmlRender;
      const reference = yield* htmlRender.loadPage({ html, path }).pipe(
        Effect.flatMap((page) =>
          htmlRender.publish({ threadId: thread.threadId, ...input, html: page, path }),
        ),
        Effect.mapError(toFailure),
      );
      return { htmlRender: reference, message: SHOWN_MESSAGE };
    }),
  ),
  html_render_update: McpToolAccess.actsAsCaller(({ renderId, html, path, title, height }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(
        scope,
        "html_render_update",
      );
      if (!attachmentBelongsToThread(thread.threadId, renderId)) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `${renderId} is not a page shown in this thread. Pass htmlRender.attachmentId from its html_render call.`,
        });
      }
      const htmlRender = yield* HtmlRender.HtmlRender;
      // A missing title or height keeps the previous version's, which clients know and the server does not look up.
      const version = yield* htmlRender.loadPage({ html, path }).pipe(
        Effect.flatMap((page) =>
          htmlRender.publish({
            threadId: thread.threadId,
            html: page,
            title: title ?? "",
            height: height ?? 0,
          }),
        ),
        Effect.mapError(toFailure),
      );
      return {
        htmlRenderUpdate: {
          renderId,
          attachmentId: version.attachmentId,
          ...(title === undefined ? {} : { title: version.title }),
          ...(height === undefined ? {} : { height: version.height }),
          ...(version.heights === undefined ? {} : { heights: version.heights }),
        },
        message: SHOWN_MESSAGE,
      };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof HtmlToolkit.tools>;

export const layerPreview = McpToolAccess.toLayer(HtmlPreviewToolkit, {
  html_preview: handlers.html_preview,
});

export const layerRender = McpToolAccess.toLayer(HtmlRenderToolkit, {
  html_render: handlers.html_render,
  html_render_update: handlers.html_render_update,
});
