# Runtime state reconciliation

Upstream V2 owns process-loss recovery through `ProviderRuntimeRecoveryService`, its durable effect outbox, and native provider/session projections. The fork no longer starts V1 reconciliation or turn reactors alongside it.

## Retained requirements

- Restart probes must remain conservative about active provider work, including startup before a concrete provider turn ID is available.
- Probes use bounded shell/runtime summaries rather than loading conversations.
- Durable queued messages and runtime requests stay visible across restart. Queued work paused by a failure or interruption must not start merely because the server restarted.
- Import native provider continuation references from the old runtime rows. Recovery must not erase that continuation or inject a second copy of the imported transcript when the native conversation can resume.
- Recovery writes native events and receipts rather than editing projections directly.

The native idle probe treats the V2 shell as the restart-safety authority after
`ProviderRuntimeRecoveryService` has reconciled startup state. An active run or
`preparing`, `starting`, `running`, or `waiting` activity status blocks restart,
including for archived shells and when a provider has not assigned a turn ID
yet. Provider adapters must publish those native run states before exposing a
live runtime; the probe intentionally has no separate V1 session directory to
consult.

The native importer, queue pause policy, and idle-status endpoint retain the fork-specific behavior. Existing V1 persistence tables remain readable for migration; they do not own current thread execution.

Review `LegacyV1ThreadImporter`, `ProviderRuntimeRecoveryService`, `QueuedRunOrder`, and `status/IdleStatus` when updating upstream. Prefer their native extension points over restoring the deleted `ProjectionOperationalReads` or legacy session reactor.
