# Runtime ingestion stall — 2026-07-16

## Goal

Prevent one event-heavy provider thread from delaying runtime state for unrelated threads, and ensure an
accepted turn is visibly working while its concrete provider turn identity is still being projected.

## Live evidence

- Production thread `28a90176-9bbe-4e80-b864-aafe175db318` accepted “Love it, let's make that change” at
  `2026-07-15T23:12:43.536Z`.
- Provider canonical logs recorded concrete turn `019f680e-1483-7b33-a617-391038b4f920` starting at
  `23:13:01.296Z`, followed by ongoing runtime events.
- The projection remained `pending`, with session status `ready` and no active turn, while the provider was
  executing. The browser consequently omitted the working state until projection caught up.
- The connected production browser had no console errors. It later rendered the turn as “Worked for 7m 46s”
  and the next active turn as “Working”, confirming delayed state delivery rather than a render crash.
- `ProviderRuntimeIngestion` feeds runtime events and `thread.turn-start-requested` domain events into one
  global `DrainableWorker`. `DrainableWorker` is strict single-item FIFO, so expensive work for one thread
  causes cross-thread head-of-line blocking.
- Production history magnifies the delay: the SQLite event store held roughly 193k orchestration events /
  458 MB of payloads, and thread resume scans the global sequence range before filtering to one thread.

## Required invariants

- Preserve FIFO ordering within a provider session/thread.
- Allow independent provider sessions/threads to make progress concurrently with bounded resource use.
- Preserve durable transcript-journal ordering and recovery semantics.
- A durable `thread.turn-start-requested` placeholder must make the thread visibly starting/working before the
  provider emits the concrete `turn.started` bridge event.
- Do not regress duplicate suppression, queued-message dispatch, checkpointing, replay, or drain/finalization.

## Plan

1. Add a deterministic ingestion regression proving a blocked thread does not delay an independent thread.
2. Add projection/client coverage for the pending-start working state.
3. Replace global runtime serialization with bounded keyed FIFO execution at the correct provider scope.
4. Verify focused suites, `vp check`, and `vp run typecheck`.
5. Update `patches/provider-turn-recovery.md`, commit, push, deploy through `~/infra`, and verify production.

## Verification status

- Live browser inspection: complete.
- Production database/log correlation: complete.
- Upstream sync through `ecb35f758399`: complete and conflict-free.
- Sync verification: `vp check` passed; `vp run typecheck` passed after `pnpm install --frozen-lockfile`
  restored lockfile-declared workspace dependencies.
- Local deterministic regression: keyed worker and real command-reactor blocking-session coverage pass.
- Implementation: keyed FIFO scheduling is complete for provider command dispatch and runtime ingestion. The
  command reactor now durably publishes `starting` before provider session work can block. Thread reconnect
  replay now queries the indexed aggregate stream instead of decoding the global event range.
- Final local verification: `vp check` and `vp run typecheck` pass. The full `vp test --maxWorkers=4` suite
  passes with 630 test files / 5,035 tests passing and 2 files / 10 tests skipped.
- First deployment verification: complete; the cross-thread/replay fixes are live, and the follow-up below
  records the remaining same-thread amplification discovered after cutover.

## Production follow-up after first cutover

- The first cutover activated `49433d0080d2`; indexed reconnect replay fell to roughly 2 ms when caught up,
  but the new server still used about 72% CPU and reached 1.6 GB resident memory within seven minutes.
- The latest 500 production orchestration events contained 439 `thread.message-sent` events for one active
  Codex thread. They were token-sized assistant deltas, confirming same-thread write amplification rather than
  the original cross-thread head-of-line block.
- The durable journal was fully drained, but processing a burst of roughly 435 token deltas took minutes
  because each delta independently resolved projections and dispatched a durable message update.
- The follow-up fix batches adjacent journaled parent assistant deltas by provider/thread/turn/item, bounded at
  24,000 characters. It retains every source event for delivered/removal bookkeeping and buffered recovery,
  adds a 16 ms collection window for accepted live deltas, and suppresses redundant volatile fallback work.
- Regression coverage proves 500 token entries become one projection batch. Focused ingestion tests, server
  typechecking, and the hard-kill transcript recovery integration test pass.
- Final verification: `vp check`, `vp run typecheck`, 60 focused tests, and the hard-kill recovery integration
  test passed. T3 Code `102dd6334d18` and infra pin `6aa874a555d4` were pushed and deployed to `srv-2`.
- Forced cutover replaced PID `308386` with PID `634515`. After startup replay settled, a five-second sample
  used 21 CPU ticks (about 4% of one core), versus roughly 74% sustained before the fix. Resident memory settled
  near 270 MB and local HTTP completed in 7 ms. The durable journal was empty.
- One existing client replayed 1,013 pre-fix events in 46 seconds after restart. That one-time backlog completed;
  future assistant token bursts use the bounded batching path and therefore create far fewer replay events.
- `just verify-host srv-2` passed all service-health checks but its final Codex version assertion raced a
  concurrent Codex 0.144.5 deployment while the isolated verification workspace still expected 0.144.4. Direct
  T3 service, HTTP, process, journal, deferred-restart, and live CPU checks passed.

## Second production follow-up: replay, reconciliation, and telemetry

### Baseline

- Large reconnects remain event-amplified even after the indexed thread query: production replays include
  5,427 thread events in about 65 minutes and 42,170 shell candidates in about 90 minutes. The cost includes
  WebSocket framing, client reduction, cache persistence, and render invalidation for every historical item.
- At `2026-07-16T14:49:48Z`, the running server had no live active provider turns but retained two projected
  running turns from the prior process epoch. `ProviderSessionReaper` skips projected active turns, while
  `getServerIdleStatus` hardcodes an empty live-session list, creating a permanent stale-state loop.
- The idle probe takes about five seconds because it hydrates the full orchestration read model. It also counts
  one 25-hour-old queued message and activity-derived pending requests as restart blockers, although those are
  durable actionable state that safely survives a restart.
- Existing replay counters are available in process diagnostics, but `srv-2` does not export OTLP metrics.
  VictoriaMetrics currently has zero `t3_*` series even though the local vmagent OTLP endpoint accepts writes.

### Active plan and acceptance targets

1. Use bounded replay probing: preserve exact event replay for small gaps; replace large gaps with a consistent
   projection snapshot followed by persisted tail replay and the already-buffered live stream.
2. Reconcile only pre-process-epoch projected turns that have no matching live provider turn. Dispatch a durable
   session event so normal projectors settle the turn; preserve provider runtime rows and resume cursors.
3. Replace full-model idle hydration with a narrow status query and real provider sessions. Only live work and
   conservative current-epoch startup state block restart; queues and pending requests remain counted/visible.
4. Export journal depth/age, batching factor/duration, replay strategy/duration, and reconciliation outcomes via
   process diagnostics and OTLP; wire `srv-2` to its local vmagent.
5. Independently review each packet, run focused and full gates, push/deploy, verify live before/after metrics,
   then build/install and smoke-test the macOS desktop bundle from the same commit.

Targets: at least 99% fewer catch-up frames and 95% lower synchronization time for the stale-thread fixture;
stale running projection rows `2 -> 0` without losing resume state; idle probe below 250 ms; and nonempty live
`t3_*` VictoriaMetrics series after deployment.

### Local implementation and verification

- Replay now uses payload-free bounded probes (thread: 256 events / 2 MiB; shell: 1,024 events / 4 MiB), then
  chooses exact events or a transactionally consistent snapshot plus persisted tail. Production uses an
  explicitly acquired scoped PubSub subscription before catch-up; buffered live completion and errors propagate.
- The 1,013-event regression emits one snapshot, 13 tail events, and one synchronization marker: 15 frames
  instead of 1,013 historical frames (72.36x fewer data frames). The 1,037-event shell fixture emits three
  frames and advances exactly to sequence 1,037.
- Startup reconciliation is now explicitly started by the production runtime. It retries after transcript
  backlog drains, preserves live `running`/`connecting` sessions, repairs sessionless legacy turns with a
  durable interrupt, and uses receipt-identical retry envelopes. Runtime bindings and resume cursors are not
  mutated.
- Journal telemetry uses one runtime-scoped incremental tracker with a bounded-compaction min-heap. A 4,000
  event recovery test emits one summary, retains zero heap entries, and performs bounded work in about 30 ms;
  the reviewed prototype emitted 4,000 logs and took about 260 ms even with output discarded.
- Three independent cross-reviews found and drove fixes for the replay acquisition race/mock regression,
  inactive reconciliation runner/false-positive repair edges, and stale concurrent telemetry snapshots plus
  quadratic recovery work.
- A final post-fix audit additionally caught two Layer/status integration gaps: adapter acceptance could not
  see the sibling tracker layer, and live `running`/`connecting` sessions without a turn id could appear idle.
  One memoized registry+tracker layer and explicit live-session blockers now cover both cases with regression
  tests.
- Final local gates: `vp check` passes with no errors; `vp run typecheck` passes; `vp run lint:mobile` passes
  (optional native linters unavailable); full `vp test --maxWorkers=4` passes 641 files / 5,132 tests, with
  2 files / 10 tests skipped. The upstream mobile outbox tests were also decoupled from the React Native runtime
  and now pass 29/29.

## Third production follow-up: interleaved recovery streams

### Live evidence

- On 2026-07-17, one Codex thread accumulated 8,061 undelivered transcript rows across concurrent turns.
- Adjacent-only batching produced 979 recovery batches for roughly 1,626 rows (1.66 source rows per batch),
  with each tiny projection write taking about 0.7–1.4 seconds. The oldest-event lag reached 29 minutes,
  T3 used about 95% of one CPU and 2.2 GiB RSS, and connection setup exceeded the client deadline.
- Stopping the active generation bounded the backlog. It eventually drained from 8,061 to zero; RSS then
  fell to roughly 713 MiB and the browser reloaded without a reconnect banner.

### Fix and verification status

- Coalesce interleaved parent-assistant deltas across independent turns while retaining exact item order
  within each turn. Subagent and lifecycle events remain hard barriers, and batches remain bounded at 24,000
  characters.
- A deterministic 4,000-row alternating-turn fixture now produces 32 projection batches instead of 4,000
  (125x fewer). Fixed-size/full and hard-boundary batches have crash-stable membership; partial open tails
  remain per-event until sealed.
- Bulk delivered/removal operations use 500-identity statements inside one SQLite transaction, avoiding
  thousands of connection acquisitions and ensuring a multi-chunk acknowledgment is all-or-none.
- An injected failure in the second removal chunk proves the first chunk rolls back; a subsequent retry
  removes all 501 rows.
- The independent final review found no remaining correctness, ordering, durability, SQLite/Effect, or
  performance blocker after the stable-membership and first-timestamp corrections.
- Final gates pass: `vp check`, `vp run typecheck`, 19 focused tests, and the full suite with 643 files /
  5,154 tests passing plus 2 files / 10 tests skipped. Remaining: commit/push, srv-2 deployment and live
  measurement, then Desktop build/install.
- After rebasing onto the concurrently advanced `main`, the focused gates passed again and the expanded full
  suite passed 644 files / 5,161 tests with 2 files / 10 tests skipped.
