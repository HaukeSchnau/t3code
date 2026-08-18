import { MessageId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const InlineReplyTextRangeSchema = Schema.Struct({
  start: Schema.Number,
  end: Schema.Number,
});

export const InlineReplyDraftSchema = Schema.Struct({
  id: Schema.String,
  messageId: MessageId,
  blockId: Schema.String,
  anchorKind: Schema.Literals(["paragraph", "selection"]),
  quote: Schema.String,
  textRange: Schema.optionalKey(InlineReplyTextRangeSchema),
  text: Schema.String,
});

export type InlineReplyDraft = typeof InlineReplyDraftSchema.Type;
