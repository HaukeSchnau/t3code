import * as Schema from "effect/Schema";

export const ArtifactReadMarkdownInput = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(8192)),
});
export const ArtifactReadMarkdownResult = Schema.Struct({ contents: Schema.String });
export class ArtifactReadMarkdownError extends Schema.TaggedError<ArtifactReadMarkdownError>()(
  "ArtifactReadMarkdownError",
  { message: Schema.String },
) {}
