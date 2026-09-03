import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Metric from "effect/Metric";
import { dual } from "effect/Function";

import {
  compactMetricAttributes,
  normalizeModelMetricLabel,
  outcomeFromExit,
} from "./Attributes.ts";

export const rpcRequestsTotal = Metric.counter("t3_rpc_requests_total", {
  description: "Total RPC requests handled by the websocket RPC server.",
});

export const rpcRequestDuration = Metric.timer("t3_rpc_request_duration", {
  description: "RPC request handling duration.",
});

export const orchestrationCommandsTotal = Metric.counter("t3_orchestration_commands_total", {
  description: "Total orchestration commands dispatched.",
});

export const orchestrationCommandDuration = Metric.timer("t3_orchestration_command_duration", {
  description: "Orchestration command dispatch duration.",
});

export const orchestrationCommandAckDuration = Metric.timer(
  "t3_orchestration_command_ack_duration",
  {
    description:
      "Time from orchestration command dispatch to the first committed domain event emitted for that command.",
  },
);

export const orchestrationEventsProcessedTotal = Metric.counter(
  "t3_orchestration_events_processed_total",
  {
    description: "Total orchestration intent events processed by runtime reactors.",
  },
);

export const providerSessionsTotal = Metric.counter("t3_provider_sessions_total", {
  description: "Total provider session lifecycle operations.",
});

export const providerTurnsTotal = Metric.counter("t3_provider_turns_total", {
  description: "Total provider turn lifecycle operations.",
});

export const providerTurnDuration = Metric.timer("t3_provider_turn_duration", {
  description: "Provider turn request duration.",
});

export const providerRuntimeEventsTotal = Metric.counter("t3_provider_runtime_events_total", {
  description: "Total canonical provider runtime events processed.",
});

export const gitCommandsTotal = Metric.counter("t3_git_commands_total", {
  description: "Total git commands executed by the server runtime.",
});

export const gitCommandDuration = Metric.timer("t3_git_command_duration", {
  description: "Git command execution duration.",
});

export const sqliteTransactionDuration = Metric.timer("t3_sqlite_transaction_duration", {
  description: "Duration of SQLite transactions, including commit or rollback.",
});

export const sqlExecuteDuration = Metric.timer("t3_sql_execute_duration", {
  description: "Duration of individual SQLite statement executions.",
  boundaries: [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1_000, 2_000, 5_000, 10_000, 30_000],
});

export const eventLoopDelayMilliseconds = Metric.gauge("t3_event_loop_delay_milliseconds", {
  description: "Mean Node.js event-loop delay during the latest collection interval.",
});

export const sqliteDatabaseSizeBytes = Metric.gauge("t3_sqlite_database_size_bytes", {
  description: "Current size of the primary SQLite database file.",
});

export const sqliteWalSizeBytes = Metric.gauge("t3_sqlite_wal_size_bytes", {
  description: "Current size of the primary SQLite write-ahead log file.",
});

export const runtimeMetricsCollectionErrors = Metric.counter(
  "t3_runtime_metrics_collection_errors_total",
  {
    description: "Runtime metric file inspections that could not produce a measurement.",
  },
);

export const terminalSessionsTotal = Metric.counter("t3_terminal_sessions_total", {
  description: "Total terminal sessions started.",
});

export const terminalRestartsTotal = Metric.counter("t3_terminal_restarts_total", {
  description: "Total terminal restart requests handled.",
});

export const replayOperationsTotal = Metric.counter("t3_replay_operations_total", {
  description: "Total persisted event replay and subscription catch-up operations.",
});

export const replayDuration = Metric.timer("t3_replay_duration", {
  description: "Duration of persisted event replay and subscription catch-up operations.",
});

export const replayPagesTotal = Metric.counter("t3_replay_pages_total", {
  description: "Total persisted event pages or batches read by replay operations.",
});

export const replayEventsScannedTotal = Metric.counter("t3_replay_events_scanned_total", {
  description: "Total persisted events scanned by replay operations before stream filtering.",
});

export const replayEventsEmittedTotal = Metric.counter("t3_replay_events_emitted_total", {
  description: "Total persisted events or stream items emitted by replay operations.",
});

export const replayOverlapEventsTotal = Metric.counter("t3_replay_overlap_events_total", {
  description: "Total live-buffer events overlapping the persisted tail and deduped by clients.",
});

export const replayLiveBufferHighWater = Metric.histogram("t3_replay_live_buffer_high_water", {
  description: "Highest number of live events buffered while persisted catch-up was in progress.",
  boundaries: Metric.exponentialBoundaries({ start: 1, factor: 2, count: 11 }),
});

export const replayStrategiesTotal = Metric.counter("t3_replay_strategies_total", {
  description: "Total replay strategies selected after bounded persistence probes.",
});

export const replayProbeEventsTotal = Metric.counter("t3_replay_probe_events_total", {
  description: "Total persisted events examined by replay strategy probes.",
});

export const replayProbeBytesTotal = Metric.counter("t3_replay_probe_bytes_total", {
  description: "Total persisted payload bytes examined by replay strategy probes.",
});

export const providerTranscriptJournalDepth = Metric.gauge("t3_provider_transcript_journal_depth", {
  description: "Last observed number of undelivered provider transcript journal rows.",
});

export const providerTranscriptJournalOldestEventLag = Metric.gauge(
  "t3_provider_transcript_journal_oldest_event_lag_milliseconds",
  {
    description:
      "Last observed age in milliseconds of the oldest undelivered provider transcript event.",
  },
);

export const providerTranscriptJournalBatchesTotal = Metric.counter(
  "t3_provider_transcript_journal_batches_total",
  {
    description: "Total provider transcript journal batches attempted by ingestion.",
  },
);

export const providerTranscriptJournalSourceEventsTotal = Metric.counter(
  "t3_provider_transcript_journal_source_events_total",
  {
    description: "Total durable source events represented by provider transcript journal batches.",
  },
);

export const providerTranscriptJournalBatchEvents = Metric.histogram(
  "t3_provider_transcript_journal_batch_events",
  {
    description: "Number of durable source events represented by one journal ingestion batch.",
    boundaries: Metric.exponentialBoundaries({ start: 1, factor: 2, count: 12 }),
  },
);

export const providerTranscriptJournalBatchCharacters = Metric.histogram(
  "t3_provider_transcript_journal_batch_characters",
  {
    description: "Assistant-text characters represented by one journal ingestion batch.",
    boundaries: Metric.exponentialBoundaries({ start: 1, factor: 2, count: 16 }),
  },
);

export const providerTranscriptJournalBatchDuration = Metric.timer(
  "t3_provider_transcript_journal_batch_duration",
  {
    description: "Duration of one provider transcript journal ingestion batch.",
  },
);

export const providerTranscriptJournalIngestionLag = Metric.timer(
  "t3_provider_transcript_journal_ingestion_lag",
  {
    description:
      "Age of the oldest canonical provider event when its journal ingestion batch begins.",
  },
);

export const runtimeReconciliationThreadsTotal = Metric.counter(
  "t3_runtime_reconciliation_threads_total",
  {
    description: "Total projected runtime threads examined or acted on by reconciliation.",
  },
);

export type RuntimeReconciliationAction = "examined" | "repaired" | "skipped" | "error";
export type RuntimeReconciliationReason =
  | "candidate"
  | "projection_current"
  | "live_turn_active"
  | "transcript_backlog"
  | "stale_projected_turn"
  | "terminal_live_session"
  | "repair_failed"
  | "unknown";

export const recordRuntimeReconciliationMetric = (input: {
  readonly action: RuntimeReconciliationAction;
  readonly reason: RuntimeReconciliationReason;
  readonly outcome: "success" | "failure";
  readonly amount?: number;
}): Effect.Effect<void> =>
  Metric.update(
    Metric.withAttributes(
      runtimeReconciliationThreadsTotal,
      metricAttributes({
        action: input.action,
        reason: input.reason,
        outcome: input.outcome,
      }),
    ),
    input.amount ?? 1,
  );

export const metricAttributes = (
  attributes: Readonly<Record<string, unknown>>,
): ReadonlyArray<[string, string]> => Object.entries(compactMetricAttributes(attributes));

export const increment = (
  metric: Metric.Metric<number, unknown>,
  attributes: Readonly<Record<string, unknown>>,
  amount = 1,
) => Metric.update(Metric.withAttributes(metric, metricAttributes(attributes)), amount);

export interface WithMetricsOptions {
  readonly counter?: Metric.Metric<number, unknown>;
  readonly timer?: Metric.Metric<Duration.Duration, unknown>;
  readonly attributes?:
    | Readonly<Record<string, unknown>>
    | (() => Readonly<Record<string, unknown>>);
  readonly outcomeAttributes?: (
    outcome: ReturnType<typeof outcomeFromExit>,
  ) => Readonly<Record<string, unknown>>;
}

const withMetricsImpl = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: WithMetricsOptions,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeNanos;
    const exit = yield* Effect.exit(effect);
    const endedAt = yield* Clock.currentTimeNanos;
    const elapsedNanos = endedAt > startedAt ? endedAt - startedAt : 0n;
    const duration = Duration.nanos(elapsedNanos);
    const baseAttributes =
      typeof options.attributes === "function" ? options.attributes() : (options.attributes ?? {});

    if (options.timer) {
      yield* Metric.update(
        Metric.withAttributes(options.timer, metricAttributes(baseAttributes)),
        duration,
      );
    }

    if (options.counter) {
      const outcome = outcomeFromExit(exit);
      yield* Metric.update(
        Metric.withAttributes(
          options.counter,
          metricAttributes({
            ...baseAttributes,
            outcome,
            ...(options.outcomeAttributes ? options.outcomeAttributes(outcome) : {}),
          }),
        ),
        1,
      );
    }

    if (Exit.isSuccess(exit)) {
      return exit.value;
    }
    return yield* Effect.failCause(exit.cause);
  });

export const withMetrics: {
  <A, E, R>(
    options: WithMetricsOptions,
  ): (effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  <A, E, R>(effect: Effect.Effect<A, E, R>, options: WithMetricsOptions): Effect.Effect<A, E, R>;
} = dual(2, withMetricsImpl);

export const providerMetricAttributes = (
  provider: string,
  extra?: Readonly<Record<string, unknown>>,
) =>
  compactMetricAttributes({
    provider,
    ...extra,
  });

export const providerTurnMetricAttributes = (input: {
  readonly provider: string;
  readonly model: string | null | undefined;
  readonly extra?: Readonly<Record<string, unknown>>;
}) => {
  const modelFamily = normalizeModelMetricLabel(input.model);
  return compactMetricAttributes({
    provider: input.provider,
    ...(modelFamily ? { modelFamily } : {}),
    ...input.extra,
  });
};
