import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as OtlpSerialization from "effect/unstable/observability/OtlpSerialization";

import { otlpMetricsSerializationLayer, otlpTraceSerializationLayer } from "./Observability.ts";

describe("OTLP serialization policy", () => {
  it.effect("exports metrics as protobuf while preserving JSON traces", () =>
    Effect.gen(function* () {
      const metricSerialization = yield* OtlpSerialization.OtlpSerialization;
      const metricBody = metricSerialization.metrics({ resourceMetrics: [] });

      if (metricBody._tag !== "Uint8Array") assert.fail("expected a byte-array metrics body");
      assert.equal(metricBody.contentType, "application/x-protobuf");
    }).pipe(Effect.provide(otlpMetricsSerializationLayer)),
  );

  it.effect("keeps trace serialization compatible with JSON collectors", () =>
    Effect.gen(function* () {
      const traceSerialization = yield* OtlpSerialization.OtlpSerialization;
      const traceBody = traceSerialization.traces({ resourceSpans: [] });

      if (traceBody._tag !== "Uint8Array") assert.fail("expected a byte-array traces body");
      assert.equal(traceBody.contentType, "application/json");
    }).pipe(Effect.provide(otlpTraceSerializationLayer)),
  );
});
