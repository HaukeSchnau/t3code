# Runtime state reconciliation

Provider processes and orchestration projections have different lifetimes. If a server exits before a
provider terminal event is ingested, the durable session and latest-turn projections can remain `running`
after the process that owned the turn is gone. Those historical rows must not block every later deferred
restart, but same-process provider startup and ingestion races must remain fail-closed.

## Requirements

- Capture one process-start epoch shared by restart-safety checks and provider-session reconciliation.
- After provider adapters and orchestration reactors are available, compare the narrow projected restart
  state with `ProviderService.listSessions()`.
- Only repair active lifecycle projections whose session or latest-turn update predates the current process,
  has no positive evidence of a running live provider session, and has no undelivered transcript journal
  events.
- Repair session-backed state by durably dispatching `thread.session.set`. Repair legacy running-turn rows
  that have no session with an explicit `thread.turn.interrupt`; never invent session fields or mutate
  projection tables directly.
- Retry reconciliation on the reaper interval so a transcript backlog or ambiguous dispatch acknowledgement
  cannot strand state indefinitely. Freeze repair command ids, timestamps, and payloads to the process epoch
  and projected identity so retries are idempotent.
- Preserve provider runtime rows, resume cursors, runtime payloads, provider instance selection, and runtime
  mode. An absent live provider turn interrupts the historical turn but does not erase continuation state.
- A current-process starting/running projection remains restart-blocking even when the adapter has not yet
  exposed a live active turn.
- Live idle probes use real provider sessions. Offline probes remain conservative.
- A live adapter session in `running` or `connecting` status blocks restart even when its concrete
  `activeTurnId` has not been observed yet.
- Queued messages and pending approval/user-input state remain counted and visible but do not block restart,
  because those records are durable. Undelivered transcript journal entries do block restart.
- Read restart safety through a narrow projection query using normalized pending counters; do not hydrate all
  messages, activities, checkpoints, or transcripts.
- Emit bounded reconciliation metrics and structured decision/repair logs without thread ids in metric labels.
- Start reconciliation through the same scoped production startup seam as orchestration reactors, after the
  reactors are available and before command readiness.

## Files

- `apps/server/src/provider/ProviderSessionReconciliation.ts`
- `apps/server/src/provider/Layers/ProviderSessionReaper.ts`
- `apps/server/src/status/IdleStatus.ts`
- `apps/server/src/status/http.ts`
- `apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts`
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
- `apps/server/src/orchestration/Layers/ProjectionOperationalReads.ts`

## Verification

- `vp test apps/server/src/provider/ProviderSessionReconciliation.test.ts apps/server/src/provider/Layers/ProviderSessionReaper.test.ts apps/server/src/status/IdleStatus.test.ts apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts apps/server/src/serverRuntimeStartup.test.ts`
- `vp run --filter t3 typecheck`

Restart-safety reads belong in `ProjectionOperationalReads.ts`. Keep
`ProjectionSnapshotQuery.ts` as the stable public service facade so operational changes do not overlap
snapshot, search, or activity-history implementation.

Production verification should compare idle-probe latency, projected active/running counts, undelivered journal
depth, and provider runtime cursor rows before and after restart. Repaired projections must become interrupted
while their persisted continuation state remains byte-for-byte intact.
