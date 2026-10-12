# Runtime performance observability

## Purpose

Separate host storage pressure and slow SQLite work from provider backlog without inspecting the
process or the database by hand. The production host receives these metrics and can alert on them.

## Behavior

- Server metrics always export as OTLP/HTTP protobuf (`application/x-protobuf`), because the
  production vmagent endpoint rejects OTLP/HTTP JSON. Upstream makes the metrics protocol
  configurable. `observability/Layers/Observability.ts` pins it with
  `otlpMetricsSerializationLayer`, and traces keep the configured protocol.
- `observability/RuntimeMetrics.ts` samples the SQLite database and WAL file sizes every 30
  seconds (`t3_sqlite_database_size_bytes`, `t3_sqlite_wal_size_bytes`). A missing WAL counts as
  zero, because SQLite removes it normally. A missing or unreadable database increments
  `t3_runtime_metrics_collection_errors_total` instead of publishing a false zero.
- `persistence/NodeSqliteClient.ts` times each SQLite transaction from semaphore acquisition to
  commit or rollback (`t3_sqlite_transaction_duration`). It also records every statement in a
  bounded histogram with an exact two-second bucket (`t3_sql_execute_duration`). SQL text and
  parameters never become labels.
- Event-loop delay comes from upstream's `EventLoopMonitor`.
- Production sends metrics and traces to the host-local OTLP collector. The collector owns
  buffering and fleet forwarding, so a remote telemetry outage does not become a T3 request-path
  dependency.

## Provider process scopes

Managed Linux hosts may set `T3_PROVIDER_SYSTEMD_SCOPE=1` and provide the service user's
`XDG_RUNTIME_DIR`. `provider/ProviderProcessSpawner.ts` then starts provider CLIs in
`t3-provider-*.scope` user units below `t3-providers.slice`, with a 15-second stop timeout. Its
layer wraps the provider instance registry and the OpenCode runtime in `server.ts`. The host owns
resource controls on the slice and must stop leftover scopes in `ExecStopPost`. Desktop and
development installs leave the variable unset.

The Claude Agent SDK spawns its CLI with Node instead of the Effect spawner, so the layer never sees
it. `ClaudeAdapterV2` and the Claude capability probe pass `nativeProviderSpawn` as the SDK's
`spawnClaudeCodeProcess`. It applies the same scope and the separate-project launcher. Without a
scope or a separate project the SDK keeps its own spawn. With one, the SDK no longer records the
CLI's stderr, so its exit errors lose that tail. The Cursor SDK runs in the server process and
spawns tool shells itself. Those still land in the server unit.

## Upstream touch points

- `apps/server/src/observability/Layers/Observability.ts`: the protobuf pin and the
  `RuntimeMetrics` layer.
- `apps/server/src/persistence/Layers/Sqlite.ts`: opens the fork's `../NodeSqliteClient.ts`
  instead of upstream's `@t3tools/shared/nodeSqliteClient`. The fork copy carries the timing, so
  port upstream changes to `packages/shared/src/nodeSqliteClient.ts` into it during syncs.
- `apps/server/src/server.ts`: the provider process spawner layer.
- `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`,
  `apps/server/src/provider/Drivers/ClaudeDriver.ts` and
  `apps/server/src/provider/Layers/ClaudeProvider.ts`: the SDK spawn hook.

## Removal

Drop the protobuf pin when the collector accepts OTLP/HTTP JSON. Drop the SQLite client copy once
upstream's shared client records transaction and statement timing.

## Verification

`Observability.test.ts` covers protobuf metrics beside JSON traces. `RuntimeMetrics.test.ts` covers
present files, normal WAL absence, and collection errors. `NodeSqliteClient.test.ts` covers
committed and rolled-back transaction timing and statement timing. `ProviderProcessSpawner.test.ts`
covers the scope command and a native launch through the project launcher. `ClaudeAdapterV2.test.ts`
covers the SDK spawn hook with and without opted-in scopes.
