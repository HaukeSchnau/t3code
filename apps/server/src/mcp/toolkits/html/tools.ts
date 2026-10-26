import { OrchestratorMcpFailure } from "@t3tools/contracts";
import {
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_LAYOUT_GUIDE,
  HTML_RENDER_MAX_FIT_HEIGHT,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MIN_HEIGHT,
  HTML_RENDER_BRIDGE_SUMMARY,
  HTML_RENDER_THEME_GUIDE,
  HTML_RENDER_TOOL_NAME,
  HTML_RENDER_UPDATE_TOOL_NAME,
} from "@t3tools/shared/htmlRender";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const Html = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512_000)).annotate({
  description: "A complete, self-contained HTML document. Pass this or path.",
});

const PagePath = Schema.String.check(Schema.isMinLength(1)).annotate({
  description: "Absolute path to an HTML file on this host, for pages too long for html.",
});

const pageSource = { html: Schema.optional(Html), path: Schema.optional(PagePath) };

const Title = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(HTML_RENDER_MAX_TITLE_LENGTH),
);

const Height = Schema.Int.annotate({
  description: `Frame height in CSS pixels, ${HTML_RENDER_MIN_HEIGHT} to ${HTML_RENDER_MAX_HEIGHT}. Use the contentHeight from html_preview.`,
});

const HtmlRenderOutput = Schema.Struct({
  attachmentId: Schema.String,
  title: Schema.String,
  height: Schema.Number,
  heights: Schema.optional(Schema.Array(Schema.Tuple([Schema.Int, Schema.Int]))),
});

const PAGE_RULES =
  "Inline <style> and <script>. Local images as absolute paths are inlined. Remote URLs load as-is.";

export const HtmlPreviewTool = Tool.make("html_preview", {
  description: `Check an HTML page before html_render. Returns PNG, contentHeight, and console output. If it says the browser is still installing, call again in a minute. ${PAGE_RULES} Theme and layout rules are in html_render.`,
  parameters: Schema.Struct({
    ...pageSource,
    width: Schema.optional(
      Schema.Int.annotate({
        description: `CSS pixels, 240 to 1600. Default ${HTML_RENDER_COLUMN_WIDTH}. Use about 390 for phones.`,
      }),
    ),
    appearance: Schema.optional(
      Schema.Literals(["dark", "light"]).annotate({
        description: "Default dark.",
      }),
    ),
  }),
  success: Schema.Struct({
    width: Schema.Int,
    contentHeight: Schema.Int,
    capturedHeight: Schema.Int,
    consoleMessages: Schema.Array(
      Schema.Struct({
        level: Schema.Literals(["log", "info", "warning", "error"]),
        text: Schema.String,
      }),
    ),
    missingImages: Schema.optional(Schema.Array(Schema.String)),
    screenshot: Schema.Struct({
      mimeType: Schema.Literal("image/png"),
      data: Schema.String,
      width: Schema.Int,
      height: Schema.Int,
    }),
  }),
  failure: OrchestratorMcpFailure,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HtmlRender.HtmlRender,
  ],
})
  .annotate(Tool.Title, "Preview HTML")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

// These affect only the caller's thread, not its workspace, so read-only sandboxes and plan mode may use them.
const HtmlRenderTool = Tool.make(HTML_RENDER_TOOL_NAME, {
  description: `Show a finished HTML page inline in this thread, above your final reply. Do not announce or restate the page. Frame fits height to ${HTML_RENDER_MAX_FIT_HEIGHT}px. On mobile, content past the given height scrolls. ${HTML_RENDER_LAYOUT_GUIDE} ${HTML_RENDER_THEME_GUIDE} ${HTML_RENDER_BRIDGE_SUMMARY}`,
  parameters: Schema.Struct({
    ...pageSource,
    title: Title,
    height: Height,
  }),
  success: Schema.Struct({
    htmlRender: HtmlRenderOutput,
    message: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HtmlRender.HtmlRender,
  ],
})
  .annotate(Tool.Title, "Render HTML")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const HtmlRenderUpdateTool = Tool.make(HTML_RENDER_UPDATE_TOOL_NAME, {
  description:
    "Replace a page you showed with html_render. The reader sees the new version in place and can page back to older ones. Saved localStorage carries over.",
  parameters: Schema.Struct({
    renderId: Schema.String.check(Schema.isMinLength(1)).annotate({
      description: "htmlRender.attachmentId from html_render.",
    }),
    ...pageSource,
    title: Schema.optional(Title),
    height: Schema.optional(Height),
  }),
  success: Schema.Struct({
    htmlRenderUpdate: Schema.Struct({
      renderId: Schema.String,
      attachmentId: Schema.String,
      title: Schema.optional(Schema.String),
      height: Schema.optional(Schema.Number),
      heights: Schema.optional(Schema.Array(Schema.Tuple([Schema.Int, Schema.Int]))),
    }),
    message: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HtmlRender.HtmlRender,
  ],
})
  .annotate(Tool.Title, "Update HTML")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const HtmlPreviewToolkit = Toolkit.make(HtmlPreviewTool);

export const HtmlRenderToolkit = Toolkit.make(HtmlRenderTool, HtmlRenderUpdateTool);

export const HtmlToolkit = Toolkit.make(HtmlPreviewTool, HtmlRenderTool, HtmlRenderUpdateTool);
