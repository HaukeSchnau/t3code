import { createOpenAIOAuthTransport, type FetchFunction } from "@openai-oauth/core";
import { openaiCredentials } from "@openai-oauth/local";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ModelSelection } from "@t3tools/contracts";
import { DEFAULT_TEXT_GENERATION_REASONING_EFFORT } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { getCodexServiceTierOptionValue } from "../codexModelOptions.ts";
import { toJsonSchemaObject } from "./TextGenerationUtils.ts";

const DIRECT_CODEX_TIMEOUT_MS = 30_000;
const encodeUnknownJsonString = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const CodexDirectResponse = Schema.Struct({
  output: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      content: Schema.optional(
        Schema.Array(
          Schema.Struct({
            type: Schema.String,
            text: Schema.optional(Schema.String),
          }),
        ),
      ),
    }),
  ),
});

export class CodexDirectTextGenerationError extends Schema.TaggedErrorClass<CodexDirectTextGenerationError>()(
  "CodexDirectTextGenerationError",
  {
    detail: Schema.String,
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface CodexDirectTextGenerationOptions {
  readonly authFilePath: string;
  readonly fetch?: FetchFunction;
  readonly codexVersion?: string;
}

export interface CodexDirectStructuredGenerationInput<S extends Schema.Top> {
  readonly prompt: string;
  readonly outputSchema: S;
  readonly outputSchemaName: string;
  readonly modelSelection: ModelSelection;
}

const decodeCodexDirectResponse = Schema.decodeUnknownEffect(CodexDirectResponse);

export function makeCodexDirectTextGeneration(options: CodexDirectTextGenerationOptions) {
  const credentials = openaiCredentials({
    authFilePath: options.authFilePath,
    ensureFresh: false,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const transport = createOpenAIOAuthTransport({
    auth: () => credentials.getSession(),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.codexVersion ? { codexVersion: options.codexVersion } : {}),
    responsesState: false,
  });

  return Effect.fn("CodexDirectTextGeneration.generateStructured")(function* <
    S extends Schema.Top,
  >({
    prompt,
    outputSchema,
    outputSchemaName,
    modelSelection,
  }: CodexDirectStructuredGenerationInput<S>): Effect.fn.Return<
    S["Type"],
    CodexDirectTextGenerationError,
    S["DecodingServices"]
  > {
    const reasoningEffort =
      getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
      DEFAULT_TEXT_GENERATION_REASONING_EFFORT;
    const serviceTier = getCodexServiceTierOptionValue(modelSelection);
    const body = {
      model: modelSelection.model,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        },
      ],
      reasoning: { effort: reasoningEffort },
      text: {
        format: {
          type: "json_schema",
          name: outputSchemaName,
          strict: true,
          schema: toJsonSchemaObject(outputSchema),
        },
      },
      ...(serviceTier ? { service_tier: serviceTier } : {}),
      store: false,
      stream: false,
    };

    const encodedBody = yield* encodeUnknownJsonString(body).pipe(
      Effect.mapError(
        (cause) =>
          new CodexDirectTextGenerationError({
            detail: "Failed to encode direct Codex request.",
            cause,
          }),
      ),
    );
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        transport.request("/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: encodedBody,
          signal,
        }),
      catch: (cause) =>
        new CodexDirectTextGenerationError({
          detail: "Direct Codex request failed before receiving a response.",
          cause,
        }),
    }).pipe(
      Effect.timeout(DIRECT_CODEX_TIMEOUT_MS),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(
          new CodexDirectTextGenerationError({ detail: "Direct Codex request timed out." }),
        ),
      ),
    );

    if (!response.ok) {
      return yield* new CodexDirectTextGenerationError({
        detail: `Direct Codex request failed with HTTP ${response.status}.`,
        status: response.status,
      });
    }

    const responseJson = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) =>
        new CodexDirectTextGenerationError({
          detail: "Direct Codex response was not valid JSON.",
          cause,
        }),
    });
    const decoded = yield* decodeCodexDirectResponse(responseJson).pipe(
      Effect.mapError(
        (cause) =>
          new CodexDirectTextGenerationError({
            detail: "Direct Codex response did not contain a valid output envelope.",
            cause,
          }),
      ),
    );
    const outputText = decoded.output
      .flatMap((item) => item.content ?? [])
      .find((content) => content.type === "output_text" && content.text !== undefined)?.text;
    if (!outputText) {
      return yield* new CodexDirectTextGenerationError({
        detail: "Direct Codex response did not contain output text.",
      });
    }

    return yield* Schema.decodeEffect(Schema.fromJsonString(outputSchema))(outputText).pipe(
      Effect.mapError(
        (cause) =>
          new CodexDirectTextGenerationError({
            detail: "Direct Codex response contained invalid structured output.",
            cause,
          }),
      ),
    );
  });
}
