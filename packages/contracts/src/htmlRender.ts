import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const HTML_RENDER_STATE_MAX_BYTES = 64 * 1024;

const utf8 = new TextEncoder();

/** The render id is the attachment id of the render's first version. */
export const HtmlRenderId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

const HtmlRenderTarget = {
  threadId: ThreadId,
  renderId: HtmlRenderId,
};

/** What a page keeps in `localStorage`; one map per render, shared by its versions. */
export const HtmlRenderState = Schema.Record(Schema.String, Schema.String).check(
  Schema.makeFilter(
    (state: Readonly<Record<string, string>>) =>
      utf8.encode(JSON.stringify(state)).byteLength <= HTML_RENDER_STATE_MAX_BYTES ||
      `Saved page state must be at most ${HTML_RENDER_STATE_MAX_BYTES} bytes.`,
  ),
);
export type HtmlRenderState = typeof HtmlRenderState.Type;

export const HtmlRenderStateInput = Schema.Struct(HtmlRenderTarget);
export type HtmlRenderStateInput = typeof HtmlRenderStateInput.Type;

export const HtmlRenderSetStateInput = Schema.Struct({
  ...HtmlRenderTarget,
  state: HtmlRenderState,
});
export type HtmlRenderSetStateInput = typeof HtmlRenderSetStateInput.Type;

export const HtmlRenderCallToolInput = Schema.Struct({
  ...HtmlRenderTarget,
  name: TrimmedNonEmptyString,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
  /** Set after the reader approved a tool that changes things. */
  confirmed: Schema.optional(Schema.Boolean),
});
export type HtmlRenderCallToolInput = typeof HtmlRenderCallToolInput.Type;

export const HtmlRenderCallToolResult = Schema.Union([
  Schema.TaggedStruct("Completed", {
    isError: Schema.Boolean,
    /** The tool's structured result, or its text when it has none. */
    value: Schema.Unknown,
  }),
  Schema.TaggedStruct("ConfirmationRequired", { title: Schema.String }),
]);
export type HtmlRenderCallToolResult = typeof HtmlRenderCallToolResult.Type;

export const HtmlRenderRequestErrorReason = Schema.Literals([
  "render-not-found",
  "tool-not-allowed",
  "rate-limited",
  "request-failed",
]);
export type HtmlRenderRequestErrorReason = typeof HtmlRenderRequestErrorReason.Type;

export class HtmlRenderRequestError extends Schema.TaggedError<HtmlRenderRequestError>()(
  "HtmlRenderRequestError",
  {
    threadId: ThreadId,
    reason: HtmlRenderRequestErrorReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "render-not-found":
        return "This page is not part of the thread.";
      case "tool-not-allowed":
        return "Pages cannot call that tool.";
      case "rate-limited":
        return "This page is calling tools too often. Wait a moment.";
      case "request-failed":
        return "The page's request failed.";
    }
  }
}
