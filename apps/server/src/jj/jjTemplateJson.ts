/**
 * jj templates print fields with `json(...)`, separated by tabs. These decode
 * one field each and throw on malformed output; callers run them inside
 * `Effect.try` so a jj format change fails the read instead of the server.
 */
import * as Schema from "effect/Schema";

const JsonString = Schema.fromJsonString(Schema.String);

export const decodeJsonString = Schema.decodeUnknownSync(JsonString);
export const decodeJsonBoolean = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Boolean));
export const decodeJsonStrings = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
/** A JSON string literal, which is also a valid TOML basic string. */
export const encodeJsonString = Schema.encodeSync(JsonString);
