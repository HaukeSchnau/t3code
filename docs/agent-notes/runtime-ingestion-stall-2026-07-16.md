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
- Remaining: full repository gates, commit/push, infra pin update, deploy, then compare live CPU and event rate.
