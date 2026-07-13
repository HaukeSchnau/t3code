# Energy Amplification Optimization — 2026-07-13

## Active Goal

Make high-cardinality, long-running provider sessions scale with semantic state changes rather than raw provider chunks while preserving byte-exact transcripts and reconnect/replay correctness.

## Confirmed Baseline Architecture

- Every subagent runtime event currently dispatches a cumulative `subagent.thread` activity, including command-output chunks that change no transcript, status, or useful activity text.
- Some subagent tool events also produce a second raw activity event.
- Every durable event writes an event and command receipt, then runs all 11 SQL projectors and advances all 11 projector cursors even when most projectors are no-ops.
- Shell-summary refreshes load complete message, plan, activity, and approval collections on hot detail events.
- The shell stream queries and republishes a thread shell for almost every thread aggregate event, once per subscriber.
- The sidebar prewarms ten full thread-detail subscriptions; each reduces live events and debounces complete snapshot serialization to IndexedDB.
- Native and canonical provider payload loggers are enabled by default and use separate rotating writers against the same per-thread path.
- Provider event command IDs include random UUIDs, so duplicate runtime delivery is not durably idempotent.

## Invariants and Assumptions

- The representative 22 MiB fixture is command output, not a 22 MiB assistant transcript. Exact retention and under-5-MiB DB growth would otherwise conflict physically.
- Subagent identity must include parent thread, provider kind/instance, and child provider thread ID.
- Waiting/running/terminal status transitions publish immediately; transcript and ordinary activity deltas may coalesce on deterministic event-time windows.
- Pending coalesced state flushes on completion, interruption/abort, runtime error, session exit, drain, and finalization.
- Approval and structured user-input lifecycle events remain distinct because shell actionability depends on them.
- Suppressed shell events must still advance a separate resume cursor without replacing shell state or invalidating sidebar derivations.
- Inactive sidebar threads perform no detail reducer or persistence work. Intentionally visible monitor tiles remain bounded detail consumers.
- Default provider logs retain fixed-size metadata only. Full payload capture requires an explicit bounded diagnostic mode.

## Workstreams

1. **Fixture and baseline** — deterministic 9,200-chunk generator, file-backed SQLite benchmark, event/receipt/payload/DB/elapsed metrics, lifecycle variants.
2. **Ingestion** — duplicate-event protection, semantic unchanged suppression, subagent coalescing, lifecycle flushes.
3. **Projection** — route events only to relevant projectors and replace hot full-history shell-summary scans with event-local updates.
4. **Shell/client** — shell-visible filtering plus cursor-only frames, reconnect tests, remove sidebar detail prewarming, incremental reducer fast paths.
5. **Logging/diagnostics** — metadata-only default provider logs and counters/profile summaries needed for headless proof.
6. **Verification/docs** — focused lifecycle and replay tests, full gates, real headless server exercise, benchmark comparison, patch documentation.

### Planned Atomic Boundaries

- `test: add energy amplification regression benchmark` — generated fixture, real SQLite runner, lifecycle/replay assertions, reproducible baseline.
- `fix: coalesce provider subagent publications` — semantic suppression, deterministic idempotency, bounded event-time coalescing, terminal/drain flushes.
- `perf: make orchestration projections event-local` — relevant-projector routing and incremental shell-summary maintenance.
- `perf: keep inactive threads shell-only` — cursor-only shell advancement, shell-visible filtering, removal of sidebar detail prewarming, reducer fast paths.
- `fix: bound provider event diagnostics` — metadata-only default logs, distinct sinks, workload counters and headless diagnostics summary.
- `docs: record energy amplification optimization wave` — fork patch requirements, benchmark results, verification, residual risks, packaged-Mac handoff.

## Progress

- Fetched `origin`; restored and fetched canonical `upstream` remote.
- Merged three upstream commits in isolated `merge: sync upstream main` change.
- Resolved two mobile conflicts with delegated review.
- Sync gates passed: `vp check`, `vp run typecheck`, and `vp run lint:mobile` (Linux skipped unavailable native lint binaries).
- Completed architecture/correctness and diagnostics/benchmark reviews before feature edits.
- Implemented the deterministic benchmark, semantic ingestion/coalescing, event-routed projection transaction, shell cursor protocol, inactive detail teardown, incremental reducers, bounded metadata logging, and workload diagnostics surface.
- Exercised a real persistent headless server on `srv-2` with an isolated home. `agent-service verify t3-energy-headless` confirmed the process/socket/HTTP surface, and `t3 diagnostics workload --json` authenticated against it and returned schema version 1 counters/gauges.

## Verification Status

- Baseline benchmark: complete on `srv-2` with the pre-optimization modules loaded.
  - Command: `node apps/server/scripts/energy-amplification-benchmark.ts`
  - 9,200 chunks / 23,068,672 bytes; 9,209 durable events; 9,203 activity events; 9,208 receipts.
  - 4,667,304 durable payload bytes; 17,166,336 bytes checkpointed SQLite growth.
  - 241,383.13 ms elapsed; final 73-byte transcript and repeated replay hashes exact; session ready.
- Final completed benchmark: 9 durable events, 2,984 payload bytes, 8 receipts, 8,192 bytes checkpointed DB growth, 4,515.96 ms elapsed, exact completion replay after a fresh runtime/projection rebuild.
- Final interrupted benchmark: 9 durable events, 3,033 payload bytes, 8 receipts, 8,192 bytes checkpointed DB growth, 4,370.73 ms elapsed. This variant appends a dirty assistant transcript delta and then aborts the parent turn; the pending transcript, `interrupted` session state, and `interrupted` latest-turn state replay exactly after a fresh runtime/projection rebuild.
- Focused ingestion/projection/fixture aggregate: 3 files / 76 tests passed.
- Focused shell/contracts/client aggregate: 7 files / 135 tests passed.
- Focused logging/diagnostics/HTTP aggregate: 6 files / 144 tests passed.
- `vp check`: passed with zero errors and 10 pre-existing React warnings. A first stdout-heavy run hit a Vite+ `EAGAIN` printing panic; the redirected rerun passed.
- `vp run typecheck`: passed across all 15 packages.
- `vp test --maxWorkers 4 --maxConcurrency 2`: 601 files / 4,805 tests passed; 2 files / 7 tests skipped. Default-concurrency attempts exposed unrelated ACP/Grok timing flakes, each of which passed immediately in isolation; the bounded full run passed.
- `vp run test`: passed across the complete package-script graph. Server: 173 files / 1,513 tests passed (2 files / 7 tests skipped); web: 154 files / 1,346 tests passed; all other package suites passed.
- Final adversarial review: passed with no release-blocking findings after an independent 84-test review and 58-test lifecycle/dedupe rerun.
- Test portability stabilization: made BTRFS workspace expectations capability-aware and forced recursive-copy-specific tests onto a non-COW platform; expanded three import-heavy web test budgets and one ACP replay-start budget for full-suite contention. No production behavior changed in this stabilization.
- Headless server smoke: passed.
- Packaged Mac energy capture: explicitly deferred to final handoff.

## Open Risks

- Projector cursor advancement still performs 11 cursor-row upserts, now inside one atomic transaction rather than 11 transactions.
- Cursor-only persistence is debounced. Abrupt process death inside the debounce can repeat an invisible replay tail, but cannot lose shell-visible state or corrupt the resume sequence.
- Provider log filenames changed from per-thread paths to globally bounded stream paths; external tooling needs migration.
- Provider event identity deduplication retains exact IDs only for unfinished/anonymous item or turn scopes, then collapses explicit items to completed-scope markers. A single unfinished scope therefore has memory proportional to its event count—the unavoidable cost of exact arbitrary-ID duplicate detection without a provider cursor. A semantically repeated delta with a newly invented provider event ID is treated as new only while the scope is unfinished; later traffic for an explicitly completed item is rejected.
- The WebSocket catch-up queue and history pages are bounded, but the shared upstream `PubSub` can still retain a live backlog while a slow subscriber replays history. A captured replay-tail boundary or sequence-addressable bounded broker is the follow-up architecture needed to close this fully.
- A failed activity dispatch retains its accepted dirty transcript for terminal/drain retry. Semantic replay under a newly invented event identity before that retry remains ambiguous without a stable provider cursor.
- The stress harness has no shell or detail subscribers. Its zero shell/detail counters are only a harness fact; dedicated shell stream, client retention, and sidebar tests prove the inactive-detail boundary.
- Packaged-Mac long-task, process-energy, and post-settle memory validation remains the explicit final handoff.

## Current Results

- A scaled 96-chunk / 256-KiB pre-wave run produced 105 durable events and took 3.73 seconds, confirming near one-for-one raw-chunk amplification before the full baseline completed.
- The completed after-profile recorded 9,200 unchanged activity suppressions, 2 semantic activity publications, 17 projector applications out of 99 candidates, and 4 deliberate full-history reads. Detail subscription/publication gauges remained zero and the subagent coalescer gauge returned to zero.
- Compared with baseline, durable events fell 1,023x, checkpointed DB growth fell 2,095x, and elapsed time improved 53.5x on the final completed sample.
- Adversarial hardening replaced capacity/TTL-backed ingestion state with explicit lifecycle-owned maps, made transcript assembly lossless and item-aware without per-delta transcript rebuilds, strengthened activity/command identities, replaced the old 50,000-event window with lifecycle-scoped exact deduplication, made interruption use a real abort event, and verified interrupted turn state plus transcript replay through a newly constructed runtime rather than the original in-memory object.
