import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";

import { forkParked, ServerActivation } from "./serverActivation.ts";

it.effect("starts a separate trace for each cycle of a background loop", () =>
  Effect.gen(function* () {
    const spans: Array<Tracer.NativeSpan> = [];
    const layerTracer = Layer.succeed(
      Tracer.Tracer,
      Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      }),
    );
    const activated = yield* Deferred.make<void>();
    const done = yield* Deferred.make<void>();
    yield* forkParked(
      Effect.void.pipe(
        Effect.withSpan("cycle"),
        Effect.repeat({ times: 1 }),
        Effect.andThen(Deferred.succeed(done, undefined)),
      ),
    ).pipe(
      Effect.withSpan("server.lifetime"),
      // Loops wait for the server's activation at startup.
      Effect.provideService(ServerActivation, Deferred.await(activated)),
      Effect.provide(layerTracer),
    );
    yield* Deferred.succeed(activated, undefined);
    yield* Deferred.await(done);
    const cycles = spans.filter((span) => span.name === "cycle");
    expect(cycles.map((span) => span.parent._tag)).toEqual(["None", "None"]);
    expect(new Set(cycles.map((span) => span.traceId)).size).toBe(2);
  }).pipe(Effect.scoped),
);
