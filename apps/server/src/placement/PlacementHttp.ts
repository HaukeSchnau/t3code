/**
 * The routes a linked peer's placement calls here (patches/fleet-placement.md). They admit a
 * request exactly as `/mcp` does, so a link reaches them with its own credential and limits.
 */
import { PlacementReport, PlacementReportRequest, ThreadPlacement } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolDirectory from "../mcp/McpToolDirectory.ts";
import * as LocalPlacement from "./LocalPlacement.ts";
import { PLACEMENT_LAUNCH_PATH, PLACEMENT_REPORT_PATH } from "./Placement.ts";

const decodeReportRequest = Schema.decodeUnknownEffect(PlacementReportRequest);
const encodeReport = Schema.encodeEffect(PlacementReport);
const decodeLaunchRequest = Schema.decodeUnknownEffect(
  Schema.Struct({
    arguments: Schema.Record(Schema.String, Schema.Unknown),
    placement: ThreadPlacement,
    origin: Schema.optional(LocalPlacement.PlacementOrigin),
  }),
);

const noStore = { "cache-control": "no-store" };
const badRequest = HttpServerResponse.jsonUnsafe(
  { error: "invalid_request" },
  { status: 400, headers: noStore },
);

// A peer's launch runs the same tool call `/mcp` would, so every check of a linked launch holds.
const PEER_REQUEST_CONTEXT = McpSchema.McpRequestContext.of({
  clientId: -1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
});

const toolText = (content: ReadonlyArray<unknown>) =>
  content
    .map((part) =>
      Predicate.isObject(part) && "text" in part && typeof part.text === "string" ? part.text : "",
    )
    .join("");

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const authenticate = yield* McpHttpServer.makeRequestAuthenticator;
    const local = yield* LocalPlacement.LocalPlacement;
    const directory = yield* McpToolDirectory.McpToolDirectory;

    const report = HttpRouter.add(
      "POST",
      PLACEMENT_REPORT_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const admitted = yield* authenticate(request);
        if (HttpServerResponse.isHttpServerResponse(admitted)) return admitted;
        const input = yield* request.json.pipe(Effect.flatMap(decodeReportRequest), Effect.option);
        if (Option.isNone(input)) return badRequest;
        const body = yield* local.report(input.value.match).pipe(Effect.flatMap(encodeReport));
        return HttpServerResponse.jsonUnsafe(body, { headers: noStore });
      }).pipe(Effect.orDie),
    );

    const launch = HttpRouter.add(
      "POST",
      PLACEMENT_LAUNCH_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const admitted = yield* authenticate(request);
        if (HttpServerResponse.isHttpServerResponse(admitted)) return admitted;
        const input = yield* request.json.pipe(Effect.flatMap(decodeLaunchRequest), Effect.option);
        if (Option.isNone(input)) return badRequest;
        const entry = Option.getOrUndefined(yield* directory.find("t3_thread_launch"));
        if (entry === undefined) return yield* Effect.die("t3_thread_launch is not registered.");
        const outcome = yield* entry.handle(input.value.arguments).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, admitted),
          Effect.provideService(McpSchema.McpRequestContext, PEER_REQUEST_CONTEXT),
          Effect.provideService(LocalPlacement.PlacementStamp, {
            placement: input.value.placement,
            ...(input.value.origin === undefined ? {} : { origin: input.value.origin }),
          }),
          Effect.result,
        );
        if (outcome._tag === "Failure") {
          return HttpServerResponse.jsonUnsafe(
            { error: outcome.failure.message },
            { headers: noStore },
          );
        }
        const result = outcome.success;
        if (Predicate.isTagged(result, "InputRequired")) {
          return HttpServerResponse.jsonUnsafe(
            { error: "The launch asked for input." },
            { headers: noStore },
          );
        }
        return HttpServerResponse.jsonUnsafe(
          result.isError === true
            ? { error: toolText(result.content) }
            : { result: result.structuredContent },
          { headers: noStore },
        );
      }).pipe(Effect.orDie),
    );

    return Layer.mergeAll(report, launch);
  }),
);
