# Runtime performance observability

## Purpose

Separate host storage pressure and slow SQLite work from provider backlog without inspecting the
process or the database by hand. The production host receives these metrics and can alert on them.

## Behavior

- Server metrics always export as OTLP/HTTP protobuf (`application/x-protobuf`), because the
  production vmagent endpoint rejects OTLP/HTTP JSON. Upstream makes the metrics protocol
  configurable. `observability/Observability.ts` pins it with `layerOtlpMetricsSerialization`, and
  traces keep the configured protocol.
- `observability/RuntimeMetrics.ts` samples the SQLite database and WAL file sizes every 30
  seconds (`t3_sqlite_database_size_bytes`, `t3_sqlite_wal_size_bytes`). A missing WAL counts as
  zero, because SQLite removes it normally. A missing or unreadable database increments
  `t3_runtime_metrics_collection_errors_total` instead of publishing a false zero.
- The server's SQLite client times each transaction from taking its connection's lock to commit or
  rollback (`t3_sqlite_transaction_duration`). It also records every statement, on the writer and
  the reader worker, in a bounded histogram with an exact two-second bucket
  (`t3_sql_execute_duration`). SQL text and parameters never become labels.
- Event-loop delay comes from upstream's `EventLoopMonitor`.
- Production sends metrics and traces to the host-local OTLP collector. The collector owns
  buffering and fleet forwarding, so a remote telemetry outage does not become a T3 request-path
  dependency.

## Agent process scopes

Upstream's `AgentScope` (`process/agentScope.ts`) starts agents, terminals and provider runtimes in
`systemd-run --user --scope` units below `app-t3code-agents-<hash>.slice`, a child of
`app-t3code-agents.slice`, whenever `XDG_RUNTIME_DIR` is set. It sets memory limits on the slice,
attributes OOM kills to threads, and stops leftover agents on restart. The fork no longer adds its
own provider scopes. Host cgroup metrics and limits must target
`app.slice/app-t3code.slice/app-t3code-agents.slice` below the service user's manager. Separate
projects run their launcher inside the scope (see
[separate project environments](separate-project-environments.md)).

The fork caps each session's scope (`agentMemoryLimits`) and runs it with `OOMPolicy=continue`.
Upstream limits only the slice, so on srv-2 one runaway tool exhausted the host before the slice
limit applied, and the global OOM killer took unrelated sessions. With the cap the kernel kills the
largest process inside that session, the agent sees its tool killed and continues, and the thread
reports the kill from the scope's `memory.events`. When the agent process itself is the one killed
and its scope is gone before T3 reads it, the turn fails without the OOM label. `T3CODE_AGENT_MEMORY_HIGH`,
`T3CODE_AGENT_MEMORY_MAX` and `T3CODE_AGENT_SESSION_MEMORY_MAX` let a host that runs other work set
its own budget; infra sets them for srv-2. Drop this once upstream caps sessions and keeps them
running after a tool's OOM kill.

## Upstream touch points

- `apps/server/src/observability/Observability.ts`: the protobuf pin and the `RuntimeMetrics`
  layer.
- `packages/shared/src/nodeSqliteClient.ts`: the optional `timers` config
  (`SqliteClientTimers`). It wraps the writer and reader connections to time statements and
  records how long a transaction held its connection. Without `timers` the client behaves as
  upstream's.
- `apps/server/src/persistence/Sqlite.ts`: `layerFromPath` passes the two metrics from
  `observability/Metrics.ts` as `timers`.

## Removal

Drop the protobuf pin when the collector accepts OTLP/HTTP JSON. Drop the `timers` hook once
upstream's shared client records transaction and statement durations as metrics, or once the
collector derives them from the `sql.execute` spans and their `db.lock_wait_ms` attribute.

## Verification

`Observability.test.ts` covers protobuf metrics. `RuntimeMetrics.test.ts` covers
present files, normal WAL absence, and collection errors. `packages/shared/src/nodeSqliteClient.test.ts`
covers statement timing and committed and rolled-back transaction timing.
