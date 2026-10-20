import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as OtlpSerialization from "effect/observability/OtlpSerialization";

import { layerOtlpMetricsSerialization } from "./Observability.ts";

it.effect("exports metrics as OTLP protobuf", () =>
  Effect.gen(function* () {
    const serialization = yield* OtlpSerialization.OtlpSerialization;
    const body = serialization.metrics({ resourceMetrics: [] });

    if (body._tag !== "Uint8Array") assert.fail("expected a byte-array metrics body");
    assert.equal(body.contentType, "application/x-protobuf");
  }).pipe(Effect.provide(layerOtlpMetricsSerialization)),
);
