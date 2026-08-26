# Runtime performance observability

## Purpose

Runtime stalls previously had to be inferred from browser symptoms, process resource usage, and direct
SQLite inspection. This fork exposes bounded production measurements for the two durable catch-up paths
that can delay visible work: orchestration replay and provider transcript journal ingestion.

## Behavior

- Server metrics use OTLP/HTTP protobuf (`application/x-protobuf`) because the production vmagent endpoint
  rejects OTLP/HTTP JSON. Trace serialization remains JSON for the existing trace collectors and local
  decoding path.
- Replay metrics and structured completion logs report duration, pages, scanned and emitted events,
  overlap deduplication, and live-buffer high-water marks. Process-local workload diagnostics additionally
  retain total replay milliseconds and the last duration for each bounded replay flow. A replay planner can
  synchronously record its bounded `snapshot` or `events` choice, reason, and probe event/byte totals on the
  observer; optional snapshot sequence is confined to the completion report and is never a metric label.
- Transcript journal metrics report the last observed undelivered depth and oldest canonical-event age.
  Batch counters, histograms, and timers use only the bounded `phase`, `batchKind`, and `outcome`
  dimensions; provider, thread, turn, item, command, and event identifiers are never metric labels.
- Live assistant batches carry persisted membership. The batch tracker therefore reports the same source count
  and character count after a crash as it did before dispatch, including a partial final frame.
- One runtime-scoped tracker is shared by adapter acceptance and ingestion. Newly accepted durable events are
  registered immediately, successful batches remove their sources incrementally, and a compacting min-heap
  maintains oldest age without rescanning the journal or retaining unbounded stale nodes.
- Journal batch observations preserve the wrapped Effect's success, failure, or interruption. Diagnostic
  updates do not alter ingestion ordering or durability.
- `t3 diagnostics workload --json` exposes process-local counters and last-observed gauges. They reset on
  server restart and complement, rather than replace, OTLP metrics and structured replay logs.
- Individual batch completion logs are limited to unsuccessful outcomes and batches taking at least 250 ms.
  Recovery emits one bounded summary (at most eight failed event ids), so startup does not create another
  high-frequency logging path. The hot observation helpers deliberately create no per-event tracing spans.

`oldest_event_lag` measures elapsed time from the canonical provider event's `createdAt` timestamp to the
observation. It is clamped to zero under clock skew and is not presented as exact SQLite residence time.

## Verification

Focused tests use Effect's deterministic clock to prove a 500-row token burst produces one batch
observation with 500 source events, exact character counts, a 25 ms duration, and depth returning to zero.
Failure coverage proves instrumentation does not swallow the original failure. Concurrency tests cover stale
hydration, accepted-append/removal interleavings, oldest-event deletion, shared Layer identity, heap compaction,
and a 4,000-entry recovery with one summary and bounded work. Replay tests cover process-local duration totals.
