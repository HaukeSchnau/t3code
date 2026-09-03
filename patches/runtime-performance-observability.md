# Runtime performance observability

## Purpose

Runtime stalls previously had to be inferred from browser symptoms, process resource usage, and direct
SQLite inspection. This fork exposes bounded production measurements for the two durable catch-up paths
that can delay visible work: orchestration replay and provider transcript journal ingestion.
It also reports SQLite transaction duration, event-loop delay, and SQLite database/WAL size so host
storage pressure can be separated from provider or replay backlog without direct process inspection.

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
- SQLite transaction timing starts after the connection semaphore is acquired and ends after commit or
  rollback. A scoped sampler records mean event-loop delay plus database and WAL file sizes every 30 seconds.
  Every SQLite statement execution also records a bounded latency histogram with an exact two-second bucket,
  allowing the host to alert on pathological queries without attaching SQL text or parameters as labels.
  Managed Linux hosts may set `T3_PROVIDER_SYSTEMD_SCOPE=1` and provide the service user's
  `XDG_RUNTIME_DIR` to place provider CLIs in `t3-provider-*.scope` user units. Each scope has a 15-second
  stop timeout, and the host unit must stop remaining matching scopes in `ExecStopPost`. Desktop and normal
  development installs intentionally remain opt-out.
  A missing WAL is reported as zero because SQLite removes it normally; a missing or unreadable database and
  other stat failures increment `t3_runtime_metrics_collection_errors_total` instead of publishing a false
  zero-byte database measurement.
- Production sends metrics and traces to the host-local OTLP collector. The collector owns buffering and
  fleet forwarding, so a remote telemetry outage does not become a T3 request-path dependency.

`oldest_event_lag` measures elapsed time from the canonical provider event's `createdAt` timestamp to the
observation. It is clamped to zero under clock skew and is not presented as exact SQLite residence time.

## Verification

Focused tests use Effect's deterministic clock to prove a 500-row token burst produces one batch
observation with 500 source events, exact character counts, a 25 ms duration, and depth returning to zero.
Failure coverage proves instrumentation does not swallow the original failure. Concurrency tests cover stale
hydration, accepted-append/removal interleavings, oldest-event deletion, shared Layer identity, heap compaction,
and a 4,000-entry recovery with one summary and bounded work. Replay tests cover process-local duration totals.
SQLite tests cover successful and rolled-back transaction timing, present database/WAL files, normal WAL
absence, invalid event-loop samples, and missing-database collection errors.
