import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as TestClock from "effect/testing/TestClock";

import {
  readWorkloadDiagnosticsSnapshot,
  resetWorkloadDiagnosticsForTesting,
} from "../diagnostics/WorkloadDiagnostics.ts";
import { batchProviderTranscriptJournalEntries } from "../orchestration/ProviderTranscriptJournalBatch.ts";
import type { ProviderTranscriptJournalEntry } from "../persistence/Services/ProviderTranscriptJournal.ts";
import {
  makeTranscriptJournalTracker,
  observeTranscriptJournalBatch,
  TranscriptJournalTracker,
  type TranscriptJournalTrackerShape,
  withTranscriptJournalTracker,
} from "./TranscriptJournalObservability.ts";

const TrackerProbe = Context.Service<TranscriptJournalTrackerShape>(
  "t3/test/TranscriptJournalObservability/TrackerProbe",
);

function delta(sequence: number, text = "x"): ProviderTranscriptJournalEntry {
  return {
    sequence,
    batchId: null,
    event: {
      type: "content.delta",
      eventId: EventId.make(`observability-event-${sequence}`),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "1969-12-31T23:59:59.000Z",
      threadId: ThreadId.make("observability-thread"),
      turnId: TurnId.make("observability-turn"),
      itemId: RuntimeItemId.make("observability-item"),
      payload: { streamKind: "assistant_text", delta: text },
    } satisfies ProviderRuntimeEvent,
  };
}

function deltaAt(sequence: number, createdAt: string): ProviderTranscriptJournalEntry {
  const entry = delta(sequence);
  return { ...entry, event: { ...entry.event, createdAt } };
}

const metricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>> = {},
) =>
  snapshots.find(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

const histogram = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  metricSnapshot(snapshots, id, attributes) as
    | Extract<Metric.Metric.Snapshot, { readonly type: "Histogram" }>
    | undefined;

describe("TranscriptJournalObservability", () => {
  it.effect("provides one tracker instance to a consumer and its outer runtime", () =>
    Effect.gen(function* () {
      const tracker = yield* TranscriptJournalTracker;
      const probe = yield* TrackerProbe;
      assert.strictEqual(probe, tracker);
    }).pipe(
      Effect.provide(
        withTranscriptJournalTracker(Layer.effect(TrackerProbe, TranscriptJournalTracker)),
      ),
      Effect.scoped,
    ),
  );

  it.effect("measures a durable token burst as one bounded batch", () =>
    Effect.gen(function* () {
      resetWorkloadDiagnosticsForTesting();
      const entries = Array.from({ length: 128 }, (_, index) => delta(index + 1));
      const batch = batchProviderTranscriptJournalEntries(entries)[0]!;
      const tracker = yield* makeTranscriptJournalTracker;
      const before = yield* Metric.snapshot;

      yield* tracker.hydrateOnce(entries);
      const fiber = yield* observeTranscriptJournalBatch({
        tracker,
        phase: "live",
        batch,
        effect: Effect.sleep(Duration.millis(25)),
      }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(25));
      yield* Fiber.join(fiber);

      const after = yield* Metric.snapshot;
      const attributes = {
        phase: "live",
        batchKind: "assistant_delta",
        outcome: "success",
      };
      const beforeEvents = histogram(
        before,
        "t3_provider_transcript_journal_batch_events",
        attributes,
      );
      const afterEvents = histogram(
        after,
        "t3_provider_transcript_journal_batch_events",
        attributes,
      );
      const beforeDuration = histogram(
        before,
        "t3_provider_transcript_journal_batch_duration",
        attributes,
      );
      const afterDuration = histogram(
        after,
        "t3_provider_transcript_journal_batch_duration",
        attributes,
      );

      assert.equal((afterEvents?.state.count ?? 0) - (beforeEvents?.state.count ?? 0), 1);
      assert.equal((afterEvents?.state.sum ?? 0) - (beforeEvents?.state.sum ?? 0), 128);
      assert.equal((afterDuration?.state.sum ?? 0) - (beforeDuration?.state.sum ?? 0), 25);
      const workload = readWorkloadDiagnosticsSnapshot();
      assert.equal(workload.counters["ingestion.journal.batches"], 1);
      assert.equal(workload.counters["ingestion.journal.source_events"], 128);
      assert.equal(workload.counters["ingestion.journal.batch_characters"], 128);
      assert.equal(workload.counters["ingestion.journal.lag_ms_total"], 1_000);
      assert.equal(workload.gauges["ingestion.journal.last_batch_events"], 128);
      assert.equal(workload.gauges["ingestion.journal.undelivered"], 0);
      assert.equal(workload.gauges["ingestion.journal.oldest_event_lag_ms"], 0);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("preserves failures and records their bounded outcome", () =>
    Effect.gen(function* () {
      resetWorkloadDiagnosticsForTesting();
      const batch = batchProviderTranscriptJournalEntries([delta(1)])[0]!;
      const tracker = yield* makeTranscriptJournalTracker;
      yield* tracker.hydrateOnce([delta(1)]);
      const exit = yield* observeTranscriptJournalBatch({
        tracker,
        phase: "recovery",
        batch,
        effect: Effect.fail("projection failed"),
      }).pipe(Effect.exit);

      assert.equal(Exit.isFailure(exit), true);
      const workload = readWorkloadDiagnosticsSnapshot();
      assert.equal(workload.counters["ingestion.journal.batches"], 1);
      assert.equal(workload.counters["ingestion.journal.failures"], 1);
      assert.equal(workload.counters["ingestion.journal.source_events"], 1);
      assert.equal(workload.gauges["ingestion.journal.undelivered"], 1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("sets depth and oldest lag instead of accumulating observations", () =>
    Effect.gen(function* () {
      resetWorkloadDiagnosticsForTesting();
      const tracker = yield* makeTranscriptJournalTracker;
      yield* TestClock.adjust(Duration.seconds(2));
      yield* tracker.hydrateOnce([delta(1), delta(2)]);
      yield* tracker.removeSucceeded([delta(1).event]);

      const workload = readWorkloadDiagnosticsSnapshot();
      assert.equal(workload.gauges["ingestion.journal.undelivered"], 1);
      assert.equal(workload.gauges["ingestion.journal.oldest_event_lag_ms"], 3_000);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("ignores stale hydration after accepted appends interleave", () =>
    Effect.gen(function* () {
      const tracker = yield* makeTranscriptJournalTracker;
      yield* tracker.registerAccepted(delta(3).event);
      yield* tracker.hydrateOnce([delta(1), delta(2)]);
      yield* tracker.hydrateOnce([delta(1)]);

      const state = yield* tracker.debugSnapshot;
      assert.equal(state.hydrated, true);
      assert.equal(state.depth, 3);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("serializes concurrent registrations and successful removals", () =>
    Effect.gen(function* () {
      const tracker = yield* makeTranscriptJournalTracker;
      const entries = Array.from({ length: 100 }, (_, index) => delta(index + 1));
      yield* Effect.forEach(entries, (entry) => tracker.registerAccepted(entry.event), {
        concurrency: "unbounded",
        discard: true,
      });
      yield* Effect.forEach(
        entries.slice(0, 50),
        (entry) => tracker.removeSucceeded([entry.event]),
        {
          concurrency: "unbounded",
          discard: true,
        },
      );

      assert.equal((yield* tracker.debugSnapshot).depth, 50);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("advances oldest state when the current oldest event is deleted", () =>
    Effect.gen(function* () {
      const tracker = yield* makeTranscriptJournalTracker;
      const oldest = deltaAt(1, "1969-12-31T23:59:57.000Z");
      const middle = deltaAt(2, "1969-12-31T23:59:58.000Z");
      const newest = deltaAt(3, "1969-12-31T23:59:59.000Z");
      yield* tracker.hydrateOnce([newest, oldest, middle]);
      assert.equal((yield* tracker.debugSnapshot).oldestCreatedAtMs, -3_000);

      yield* tracker.removeSucceeded([oldest.event]);
      assert.equal((yield* tracker.debugSnapshot).oldestCreatedAtMs, -2_000);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("resets and permits one authoritative rehydration", () =>
    Effect.gen(function* () {
      const tracker = yield* makeTranscriptJournalTracker;
      yield* tracker.hydrateOnce([delta(1)]);
      yield* tracker.reset;
      yield* tracker.hydrateOnce([delta(2), delta(3)]);

      const state = yield* tracker.debugSnapshot;
      assert.equal(state.hydrated, true);
      assert.equal(state.depth, 2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("bounds 4k recovery logging and avoids quadratic completion work", () =>
    Effect.gen(function* () {
      const tracker = yield* makeTranscriptJournalTracker;
      const entries = Array.from({ length: 4_000 }, (_, index) => delta(index + 1));
      yield* tracker.hydrateOnce(entries);
      yield* tracker.beginRecovery({
        batchCount: entries.length,
        sourceEventCount: entries.length,
      });
      yield* Effect.forEach(
        entries,
        (entry) =>
          tracker.recordRecoveryBatch({
            batch: { event: entry.event, sourceEvents: [entry.event] },
            outcome: "success",
          }),
        { concurrency: 1, discard: true },
      );
      yield* tracker.removeSucceeded(entries.map((entry) => entry.event));
      yield* tracker.finishRecovery;

      const state = yield* tracker.debugSnapshot;
      assert.equal(state.depth, 0);
      assert.equal(state.heapSize, 0);
      assert.equal(state.recoverySummaryLogs, 1);
      assert.equal(state.workUnits < entries.length * 40, true);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
