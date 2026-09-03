import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { incrementWorkloadCounter } from "../diagnostics/WorkloadDiagnostics.ts";
import type { ReplayObservationReport } from "./ReplayObservability.ts";

const DEFAULT_REPLAY_LOG_QUEUE_CAPACITY = 128;

export class ReplayLogPublisher extends Context.Service<
  ReplayLogPublisher,
  {
    readonly publish: (report: ReplayObservationReport) => Effect.Effect<boolean>;
  }
>()("t3/observability/ReplayLogPublisher") {}

export function makeReplayLogPublisherLayer(options?: {
  readonly capacity?: number;
  readonly write?: (report: ReplayObservationReport) => Effect.Effect<void>;
}): Layer.Layer<ReplayLogPublisher> {
  const capacity = Math.max(1, Math.floor(options?.capacity ?? DEFAULT_REPLAY_LOG_QUEUE_CAPACITY));
  const write =
    options?.write ??
    ((report: ReplayObservationReport) => Effect.logInfo("orchestration replay completed", report));

  return Layer.effect(
    ReplayLogPublisher,
    Effect.gen(function* () {
      // Shutdown deliberately drops any buffered diagnostic-only records. Replay
      // delivery and metrics never depend on structured-log persistence.
      const queue = yield* Effect.acquireRelease(
        Queue.dropping<ReplayObservationReport>(capacity),
        Queue.shutdown,
      );
      yield* Stream.fromQueue(queue).pipe(Stream.runForEach(write), Effect.forkScoped);

      return ReplayLogPublisher.of({
        publish: (report) =>
          Queue.offer(queue, report).pipe(
            Effect.tap((accepted) =>
              accepted
                ? Effect.void
                : Effect.sync(() => incrementWorkloadCounter("replay.logs_dropped")),
            ),
          ),
      });
    }),
  );
}

export const layer = makeReplayLogPublisherLayer();
