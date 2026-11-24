/**
 * The routes a linked peer's placement calls here (patches/fleet-placement.md). They admit a
 * request exactly as `/mcp` does, so a link reaches them with its own credential and limits.
 */
import {
  type PlacementError,
  PlacementHydrateRequest,
  type PlacementHydrateResult,
  PlacementReport,
  PlacementReportRequest,
  ThreadPlacement,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
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
import {
  HYDRATE_TIMEOUT_MS,
  PLACEMENT_HYDRATE_PATH,
  PLACEMENT_LAUNCH_PATH,
  PLACEMENT_REPORT_PATH,
} from "./Placement.ts";

const decodeReportRequest = Schema.decodeUnknownEffect(PlacementReportRequest);
const decodeHydrateRequest = Schema.decodeUnknownEffect(PlacementHydrateRequest);
const encodeReport = Schema.encodeEffect(PlacementReport);
const decodeLaunchRequest = Schema.decodeUnknownEffect(
  Schema.Struct({
    arguments: Schema.Record(Schema.String, Schema.Unknown),
    placement: ThreadPlacement,
    origin: Schema.optional(LocalPlacement.PlacementOrigin),
  }),
);

const noStore = { "cache-control": "no-store" };
// Well inside a relay's idle limit and the sender's per-request timeout.
const HYDRATE_ANSWER_WITHIN = "20 seconds";
// A sender polls until its own deadline, so an outcome outlives it.
const HYDRATE_OUTCOME_KEPT_MS = HYDRATE_TIMEOUT_MS;
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
    // A clone outlives the request that started it; the sender asks again until it is done.
    const scope = yield* Effect.scope;
    // Each clone's outcome stays a while after it ends, so a sender asking again hears it.
    const cloning = new Map<
      string,
      {
        readonly done: Deferred.Deferred<PlacementHydrateResult, PlacementError>;
        endedAt: number | undefined;
      }
    >();

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

    const hydrate = HttpRouter.add(
      "POST",
      PLACEMENT_HYDRATE_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const admitted = yield* authenticate(request);
        if (HttpServerResponse.isHttpServerResponse(admitted)) return admitted;
        // A clone writes a project here, which only a full-access link may ask for.
        // The link's effective modes, after an administrator's ceiling and the request's own limit.
        const modes = McpInvocationContext.clientModeCeiling(admitted.client);
        if (
          admitted.client?.linked !== true ||
          modes.runtimeMode !== "full-access" ||
          modes.interactionMode !== "default"
        ) {
          return HttpServerResponse.jsonUnsafe(
            { error: "Only a link with full access may clone a repository here." },
            { status: 403, headers: noStore },
          );
        }
        const input = yield* request.json.pipe(Effect.flatMap(decodeHydrateRequest), Effect.option);
        if (Option.isNone(input)) return badRequest;
        // An older sender names no request; its clones are told apart by repository folder.
        const key =
          input.value.requestId === undefined
            ? `${input.value.repository}\n${input.value.path}`
            : `id:${input.value.requestId}`;
        const now = yield* Clock.currentTimeMillis;
        for (const [known, entry] of cloning) {
          if (entry.endedAt !== undefined && now - entry.endedAt > HYDRATE_OUTCOME_KEPT_MS) {
            cloning.delete(known);
          }
        }
        // Looked up, published and started in one step: a second request finds this clone, and
        // an interrupted request cannot leave it unstarted.
        const clone = yield* Effect.uninterruptibleMask((restore) =>
          Effect.suspend(() => {
            const known = cloning.get(key);
            // A poll never starts a clone: without its files it would be a different one.
            if (known !== undefined || input.value.poll === true) return Effect.succeed(known);
            const entry = {
              done: Deferred.makeUnsafe<PlacementHydrateResult, PlacementError>(),
              endedAt: undefined as number | undefined,
            };
            cloning.set(key, entry);
            return restore(local.hydrate(input.value)).pipe(
              Effect.exit,
              Effect.flatMap((exit) => Deferred.done(entry.done, exit)),
              Effect.ensuring(
                Clock.currentTimeMillis.pipe(
                  Effect.map((endedAt) => {
                    entry.endedAt = endedAt;
                  }),
                ),
              ),
              Effect.forkIn(scope, { uninterruptible: true }),
              Effect.as(entry),
            );
          }),
        );
        if (clone === undefined) {
          return HttpServerResponse.jsonUnsafe(
            { error: "This machine has no clone for that request." },
            { headers: noStore },
          );
        }
        const outcome = yield* Deferred.await(clone.done).pipe(
          Effect.result,
          Effect.timeoutOption(HYDRATE_ANSWER_WITHIN),
        );
        return HttpServerResponse.jsonUnsafe(
          Option.isNone(outcome)
            ? { pending: true }
            : outcome.value._tag === "Success"
              ? { result: outcome.value.success }
              : { error: outcome.value.failure.message },
          { headers: noStore },
        );
      }).pipe(Effect.orDie),
    );

    return Layer.mergeAll(report, launch, hydrate);
  }),
);
