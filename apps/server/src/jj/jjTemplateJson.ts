/**
 * jj templates print fields with `json(...)`, separated by tabs. These decode
 * one field each and throw on malformed output; callers run them inside
 * `parseJjOutput` so a jj format change fails the read instead of the server.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class JjOutputParseError extends Schema.TaggedError<JjOutputParseError>()(
  "JjOutputParseError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "jj printed output T3 Code could not read.";
  }
}

export const parseJjOutput = <A>(parse: () => A) =>
  Effect.try({ try: parse, catch: (cause) => new JjOutputParseError({ cause }) });

const JsonString = Schema.fromJsonString(Schema.String);

export const decodeJsonString = Schema.decodeUnknownSync(JsonString);
export const decodeJsonBoolean = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Boolean));
export const decodeJsonStrings = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
/** A JSON string literal, which is also a valid TOML basic string. */
export const encodeJsonString = Schema.encodeSync(JsonString);
