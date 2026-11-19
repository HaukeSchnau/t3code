import {
  CommandId,
  OrchestratorMcpFailure,
  THREAD_ASK_TEXT_MAX_LENGTH,
  ThreadAskId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { attachmentBelongsToThread } from "../../../attachmentStore.ts";
import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";
import * as HtmlRenderIndex from "../../../htmlRender/HtmlRenderIndex.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";
import { HtmlPreviewToolkit, HtmlRenderToolkit, type HtmlToolkit } from "./tools.ts";

const INVALID_PAGE_ERRORS = new Set([
  "HtmlRenderFileError",
  "HtmlRenderFileTooLargeError",
  "HtmlRenderImagesNotFoundError",
  "HtmlRenderImageTooLargeError",
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

// The server reads the file for the caller, so only a thread that reads files without asking may
// pass a path; a supervised thread passes the HTML its provider already let it read.
const pageSource = Effect.fn("HtmlToolkit.pageSource")(function* (input: {
  readonly html?: string | undefined;
  readonly path?: string | undefined;
}) {
  if (input.html !== undefined && input.path === undefined) {
    return { html: input.html } satisfies HtmlRender.HtmlRenderSource;
  }
  if (input.path === undefined || input.html !== undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "Pass exactly one of html or path.",
    });
  }
  const { limits } = yield* loadCaller();
  if (limits.runtimeMode !== "full-access") {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Pass html instead of path: only full-access threads may pass a path.",
    });
  }
  return { path: input.path } satisfies HtmlRender.HtmlRenderSource;
});

const askText = (ask: string) => {
  const line = ask.replace(/\s+/g, " ").trim();
  return line.length <= THREAD_ASK_TEXT_MAX_LENGTH
    ? line
    : `${line.slice(0, THREAD_ASK_TEXT_MAX_LENGTH - 1).trimEnd()}…`;
};

/**
 * Raises, updates or (with "") withdraws the page's ask. The page already shows, so a failure
 * is logged rather than returned: the agent would publish the page again.
 */
const syncPageAsk = Effect.fn("HtmlToolkit.syncPageAsk")(function* (input: {
  readonly threadId: ThreadId;
  readonly renderId: string;
  readonly attachmentId: string;
  readonly ask: string | undefined;
}) {
  if (input.ask === undefined) return;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const text = askText(input.ask);
  // The calling run's own ending repeats the page's question, so the detector skips that run.
  const runId = yield* threads.getThreadShell(input.threadId).pipe(
    Effect.map((shell) => shell?.activeRunId ?? undefined),
    Effect.orElseSucceed(() => undefined),
  );
  yield* threads
    .dispatch(
      text === ""
        ? {
            type: "thread.ask.withdraw",
            commandId: CommandId.make(`html-render-ask:${input.attachmentId}`),
            threadId: input.threadId,
            renderId: input.renderId,
          }
        : {
            type: "thread.ask.raise",
            commandId: CommandId.make(`html-render-ask:${input.attachmentId}`),
            threadId: input.threadId,
            askId: ThreadAskId.make(`page:${input.attachmentId}`),
            source: {
              type: "page",
              renderId: input.renderId,
              ...(runId === undefined ? {} : { runId }),
            },
            text,
          },
    )
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not update a page's ask.", { renderId: input.renderId, cause }),
      ),
    );
});

const handlers = {
  // Local-file access limits this host browser to T3-launched agents.
  html_preview: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const htmlRender = yield* HtmlRender.HtmlRender;
      const source = yield* pageSource(input);
      const { png, ...preview } = yield* htmlRender
        .preview({ ...source, width: input.width, appearance: input.appearance })
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
  html_render: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "html_render");
      const htmlRender = yield* HtmlRender.HtmlRender;
      const source = yield* pageSource(input);
      const reference = yield* htmlRender
        .publish({ ...source, threadId: thread.threadId, title: input.title, height: input.height })
        .pipe(Effect.mapError(toFailure));
      // An empty ask on a new page has nothing to withdraw.
      if (input.ask?.trim()) {
        yield* syncPageAsk({
          threadId: thread.threadId,
          renderId: reference.attachmentId,
          attachmentId: reference.attachmentId,
          ask: input.ask,
        });
      }
      return { htmlRender: reference, message: SHOWN_MESSAGE };
    }),
  ),
  html_render_update: McpToolAccess.actsAsCaller(({ renderId, title, height, ask, ...input }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(
        scope,
        "html_render_update",
      );
      const pages = yield* HtmlRenderIndex.HtmlRenderIndex;
      const shown =
        attachmentBelongsToThread(thread.threadId, renderId) &&
        (yield* pages
          .isPage({ threadId: thread.threadId, renderId })
          .pipe(Effect.mapError(toFailure)));
      if (!shown) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `${renderId} is not a page shown in this thread. Pass htmlRender.attachmentId from its html_render call.`,
        });
      }
      const htmlRender = yield* HtmlRender.HtmlRender;
      const source = yield* pageSource(input);
      // A missing title or height keeps the previous version's, which clients know and the server does not look up.
      const version = yield* htmlRender
        .publish({
          ...source,
          threadId: thread.threadId,
          renderId,
          title: title ?? "",
          height: height ?? 0,
        })
        .pipe(Effect.mapError(toFailure));
      yield* syncPageAsk({
        threadId: thread.threadId,
        renderId,
        attachmentId: version.attachmentId,
        ask,
      });
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
