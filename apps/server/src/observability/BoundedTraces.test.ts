import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

import { boundTraces } from "./BoundedTraces.ts";

const MINUTE = 60_000;

const recording = () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const clock = { now: 0 };
  const layer = Layer.succeed(
    Tracer.Tracer,
    boundTraces(
      Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      }),
      () => clock.now,
    ),
  );
  const named = (name: string) => spans.find((span) => span.name === name)!;
  const all = (name: string) => spans.filter((span) => span.name === name);
  return { layer, clock, named, all };
};

const parentIdOf = (span: Tracer.NativeSpan) => Option.getOrUndefined(span.parent)?.spanId;
const linkedIdOf = (span: Tracer.NativeSpan) => span.links[0]?.span.spanId;

it.effect("a loop that outlives the span that started it starts a trace per cycle", () => {
  const { layer, named, all } = recording();
  return Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const loop = yield* Deferred.await(started).pipe(
      Effect.andThen(Effect.void.pipe(Effect.withSpan("cycle"), Effect.repeat({ times: 1 }))),
      Effect.forkChild,
      Effect.withSpan("startup"),
    );
    yield* Deferred.succeed(started, undefined);
    yield* Fiber.join(loop);
    const cycles = all("cycle");
    expect(cycles.map((span) => span.parent._tag)).toEqual(["None", "None"]);
    expect(new Set(cycles.map((span) => span.traceId)).size).toBe(2);
    expect(cycles.map(linkedIdOf)).toEqual([named("startup").spanId, named("startup").spanId]);
  }).pipe(Effect.provide(layer));
});

it.effect("a trace takes new spans for ten minutes, also through younger open parents", () => {
  const { layer, clock, named } = recording();
  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      clock.now = 9 * MINUTE;
      yield* Effect.gen(function* () {
        yield* Effect.void.pipe(Effect.withSpan("early"));
        clock.now = 11 * MINUTE;
        yield* Effect.void.pipe(Effect.withSpan("late"));
      }).pipe(Effect.withSpan("subscription"));
    }).pipe(Effect.withSpan("connection"));
    const connection = named("connection");
    expect(named("subscription").traceId).toBe(connection.traceId);
    expect(named("early").traceId).toBe(connection.traceId);
    expect(parentIdOf(named("early"))).toBe(named("subscription").spanId);
    const late = named("late");
    expect(late.parent._tag).toBe("None");
    expect(late.traceId).not.toBe(connection.traceId);
    expect(linkedIdOf(late)).toBe(named("subscription").spanId);
  }).pipe(Effect.provide(layer));
});
