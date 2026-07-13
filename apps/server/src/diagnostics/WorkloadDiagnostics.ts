import type { WorkloadDiagnosticsSnapshot } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const WORKLOAD_COUNTER_NAMES = [
  "provider.events.received",
  "provider.delta.chunks",
  "provider.delta.characters",
  "provider.events.duplicates_suppressed",
  "ingestion.activity.candidates",
  "ingestion.activity.unchanged_suppressed",
  "ingestion.activity.coalesced",
  "ingestion.activity.published",
  "ingestion.activity.flushes",
  "orchestration.events.durable",
  "projection.candidates",
  "projection.applied",
  "projection.skipped",
  "projection.full_history_reads",
  "shell.candidates",
  "shell.upserts",
  "shell.cursor_only",
  "shell.suppressed",
  "thread_detail.events_published",
  "provider_log.candidates",
  "provider_log.records",
  "provider_log.sampled_suppressed",
  "provider_log.bytes",
] as const;

export const WORKLOAD_GAUGE_NAMES = [
  "subscriptions.shell.active",
  "subscriptions.detail.active",
  "ingestion.subagent_coalescers.active",
  "ingestion.dedupe.events.active",
] as const;

export type WorkloadCounterName = (typeof WORKLOAD_COUNTER_NAMES)[number];
export type WorkloadGaugeName = (typeof WORKLOAD_GAUGE_NAMES)[number];

export interface WorkloadDiagnosticsRegistry {
  readonly increment: (name: WorkloadCounterName, amount?: number) => void;
  readonly adjustGauge: (name: WorkloadGaugeName, amount: number) => void;
  readonly snapshot: () => WorkloadDiagnosticsSnapshot;
}

function zeroRecord<const Names extends ReadonlyArray<string>>(
  names: Names,
): Record<Names[number], number> {
  return Object.fromEntries(names.map((name) => [name, 0])) as Record<Names[number], number>;
}

function nonNegativeInt(amount: number): number {
  return Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0;
}

export function makeWorkloadDiagnosticsRegistry(
  startedAtIso = DateTime.formatIso(DateTime.nowUnsafe()),
): WorkloadDiagnosticsRegistry {
  const counters = zeroRecord(WORKLOAD_COUNTER_NAMES);
  const gauges = zeroRecord(WORKLOAD_GAUGE_NAMES);

  return {
    increment(name, amount = 1) {
      counters[name] += nonNegativeInt(amount);
    },
    adjustGauge(name, amount) {
      const next = gauges[name] + Math.trunc(Number.isFinite(amount) ? amount : 0);
      gauges[name] = Math.max(0, next);
    },
    snapshot() {
      return {
        schemaVersion: 1,
        startedAtIso,
        readAtIso: DateTime.formatIso(DateTime.nowUnsafe()),
        counters: { ...counters },
        gauges: { ...gauges },
      };
    },
  };
}

const liveRegistry = makeWorkloadDiagnosticsRegistry();

export function incrementWorkloadCounter(name: WorkloadCounterName, amount = 1): void {
  liveRegistry.increment(name, amount);
}

export function adjustWorkloadGauge(name: WorkloadGaugeName, amount: number): void {
  liveRegistry.adjustGauge(name, amount);
}

export function readWorkloadDiagnosticsSnapshot(): WorkloadDiagnosticsSnapshot {
  return liveRegistry.snapshot();
}

export class WorkloadDiagnostics extends Context.Service<
  WorkloadDiagnostics,
  { readonly read: Effect.Effect<WorkloadDiagnosticsSnapshot> }
>()("t3/diagnostics/WorkloadDiagnostics") {}

export const layer = Layer.succeed(
  WorkloadDiagnostics,
  WorkloadDiagnostics.of({ read: Effect.sync(readWorkloadDiagnosticsSnapshot) }),
);
