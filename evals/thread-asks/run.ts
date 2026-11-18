#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeUtil from "node:util";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import { toJsonSchemaObject } from "@t3tools/provider-core/server/textGenerationUtils";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { threadAskCases, type ThreadAskCase } from "./cases.ts";
import { casePasses, gradeThreadAsk } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: "claude-haiku-5-5" },
    effort: { type: "string" },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "3" },
    concurrency: { type: "string", default: "6" },
    baseline: { type: "string" },
  },
});
const samples = Number(values.samples);
const concurrency = Number(values.concurrency);
const selected = values.case
  ? threadAskCases.filter((entry) => values.case!.includes(entry.id))
  : threadAskCases;
if (
  !values.out ||
  selected.length === 0 ||
  !Number.isSafeInteger(samples) ||
  samples < 1 ||
  !Number.isSafeInteger(concurrency) ||
  concurrency < 1
) {
  throw new Error(
    "Use --out <directory> [--model <id>] [--effort <level>] [--case <id>] [--samples <n>] [--baseline <results.jsonl>].",
  );
}
const outDirectory = values.out;
const model = values.model;

/** USD per million tokens, for the summary's cost line. */
const PRICES: Record<string, { readonly input: number; readonly output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
};

const ApiResponse = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
  ),
  usage: Schema.Struct({ input_tokens: Schema.Number, output_tokens: Schema.Number }),
});
const decodeApiResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(ApiResponse));

const Row = Schema.Struct({
  id: Schema.String,
  sample: Schema.Number,
  waits: Schema.Boolean,
  waitsOnUser: Schema.optional(Schema.Boolean),
  ask: Schema.optional(Schema.String),
  pass: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
  error: Schema.optional(Schema.String),
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
});
type Row = typeof Row.Type;
const encodeRow = Schema.encodeEffect(Schema.fromJsonString(Row));
const decodeRow = Schema.decodeUnknownEffect(Schema.fromJsonString(Row));

// Overloads and rate limits pass; back off for up to about 4 minutes with jitter.
const RETRY = Schedule.min([Schedule.exponential("2 seconds"), Schedule.spaced("1 minute")]).pipe(
  Schedule.jittered,
);

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const apiKey = yield* Config.String("ANTHROPIC_API_KEY").pipe(Config.withDefault(""));
  if (!apiKey) return yield* Effect.die(new Error("Set ANTHROPIC_API_KEY in the repo root .env."));
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatus((status) => status !== 529),
    HttpClient.retryTransient({
      retryOn: "errors-and-responses",
      while: (error) =>
        error.reason._tag === "StatusCodeError" && error.reason.response.status === 529,
      schedule: RETRY,
      times: 8,
    }),
  );

  const callModel = Effect.fn("evaluateThreadAsks.callModel")(function* (
    prompt: string,
    schema: unknown,
  ) {
    const response = yield* HttpClientRequest.post("https://api.anthropic.com/v1/messages").pipe(
      HttpClientRequest.setHeaders({ "x-api-key": apiKey, "anthropic-version": "2023-06-01" }),
      HttpClientRequest.bodyJson({
        model,
        max_tokens: 4_096,
        messages: [{ role: "user", content: prompt }],
        output_config: {
          ...(values.effort === undefined ? {} : { effort: values.effort }),
          format: { type: "json_schema", schema },
        },
      }),
      Effect.flatMap(client.execute),
    );
    const body = yield* response.text;
    if (response.status !== 200) {
      return yield* new TextGenerationError({
        operation: "generateTurnEndAsk",
        detail: `Model API ${response.status}: ${body}`,
      });
    }
    const decoded = yield* decodeApiResponse(body);
    return {
      text: decoded.content
        .flatMap((block) => (block.type === "text" ? [block.text ?? ""] : []))
        .join(""),
      inputTokens: decoded.usage.input_tokens,
      outputTokens: decoded.usage.output_tokens,
    };
  });

  // The server's own text-generation path, with the Anthropic API in place of the Claude CLI.
  // Structured output stands in for the CLI's --json-schema.
  const runOne = Effect.fn("evaluateThreadAsks.runOne")(function* (
    testCase: ThreadAskCase,
    sample: number,
  ) {
    const usage = { inputTokens: 0, outputTokens: 0 };
    const runner: TextGenerationOperations.Runner = (request) =>
      callModel(request.prompt, toJsonSchemaObject(request.outputSchema)).pipe(
        Effect.tap((reply) =>
          Effect.sync(() => {
            usage.inputTokens += reply.inputTokens;
            usage.outputTokens += reply.outputTokens;
          }),
        ),
        Effect.mapError((cause) =>
          cause._tag === "TextGenerationError"
            ? cause
            : new TextGenerationError({
                operation: request.operation,
                detail: cause.message,
                cause,
              }),
        ),
        Effect.flatMap((reply) =>
          TextGenerationOperations.decodeJsonReply(request, "Anthropic API", reply.text),
        ),
      );
    const generation = TextGenerationOperations.fromRunner("ThreadAsksEval", runner);
    const result = yield* generation
      .generateTurnEndAsk({
        cwd: "/home/user/app",
        finalMessage: testCase.finalMessage,
        userMessage: testCase.userMessage,
        modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model },
      })
      .pipe(Effect.result);
    const base = { id: testCase.id, sample, waits: testCase.waits, ...usage };
    const row: Row =
      result._tag === "Failure"
        ? { ...base, pass: false, reason: null, error: result.failure.detail }
        : { ...base, ...result.success, ...gradeThreadAsk(testCase, result.success) };
    return row;
  });

  const jobs = selected.flatMap((testCase) =>
    Array.from({ length: samples }, (_, index) => [testCase, index + 1] as const),
  );
  const rows = yield* Effect.forEach(jobs, ([testCase, sample]) => runOne(testCase, sample), {
    concurrency,
  });

  const baseline = values.baseline
    ? yield* fs.readFileString(values.baseline).pipe(
        Effect.flatMap((text) =>
          Effect.forEach(
            text.split("\n").filter((line) => line.trim() !== ""),
            (line) => decodeRow(line),
          ),
        ),
      )
    : [];
  const price = PRICES[model];
  const inputTokens = rows.reduce((total, row) => total + row.inputTokens, 0);
  const outputTokens = rows.reduce((total, row) => total + row.outputTokens, 0);
  const passedCases = selected.filter((testCase) =>
    casePasses(rows.filter((row) => row.id === testCase.id)),
  );
  const lines = [
    `# Thread asks`,
    "",
    `${model}${values.effort === undefined ? "" : ` at ${values.effort} effort`}, ${samples} samples per case, ${selected.length} cases.`,
    "",
    `- Cases passed: ${passedCases.length} of ${selected.length} (waiting ${passedCases.filter((entry) => entry.waits).length} of ${selected.filter((entry) => entry.waits).length}, controls ${passedCases.filter((entry) => !entry.waits).length} of ${selected.filter((entry) => !entry.waits).length}).`,
    `- Samples passed: ${rows.filter((row) => row.pass).length} of ${rows.length}; errored: ${rows.filter((row) => row.error !== undefined).length}.`,
    `- Tokens: ${inputTokens} in, ${outputTokens} out${price === undefined ? "" : `, about $${((inputTokens * price.input + outputTokens * price.output) / 1_000_000).toFixed(4)}`}.`,
    "",
    `| Case | Waits | Passed${values.baseline ? " | Baseline" : ""} | Asks and failures |`,
    `| --- | --- | --- | ${values.baseline ? "--- | " : ""}--- |`,
    ...selected.map((testCase) => {
      const caseRows = rows.filter((row) => row.id === testCase.id);
      const passed = `${caseRows.filter((row) => row.pass).length}/${caseRows.length}${casePasses(caseRows) ? "" : " FAIL"}`;
      const baselineRows = baseline.filter((row) => row.id === testCase.id);
      const notes = caseRows
        .map(
          (row) => row.error ?? (row.pass ? (row.ask ?? "") : `${row.reason}: "${row.ask ?? ""}"`),
        )
        .filter((note) => note !== "")
        .map((note) => note.replaceAll("|", "\\|"))
        .join("; ");
      return `| \`${testCase.id}\` | ${testCase.waits ? "yes" : "no"} | ${passed}${values.baseline ? ` | ${baselineRows.filter((row) => row.pass).length}/${baselineRows.length}` : ""} | ${notes} |`;
    }),
  ];
  const summary = `${lines.join("\n")}\n`;
  yield* fs.makeDirectory(outDirectory, { recursive: true });
  const encoded = yield* Effect.forEach(rows, (row) => encodeRow(row));
  yield* fs.writeFileString(path.join(outDirectory, "results.jsonl"), `${encoded.join("\n")}\n`);
  yield* fs.writeFileString(path.join(outDirectory, "summary.md"), summary);
  yield* Effect.log(`Wrote ${rows.length} samples to ${outDirectory}.\n\n${summary}`);
});

if (import.meta.main) {
  main.pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    NodeRuntime.runMain,
  );
}
