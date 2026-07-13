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
- Waiting/running/terminal status transitions publish immediately. Current providers durably publish every semantic assistant transcript change; only an adapter with tested authoritative recovery may coalesce transcript deltas. Ordinary activity changes may still coalesce on deterministic event-time windows.
- Pending coalesced state flushes on completion, interruption/abort, runtime error, session exit, drain, and finalization.
- Abrupt process loss after a semantic transcript event commits cannot lose accepted bytes. Transient persistence failures backpressure semantic publication and do not mark the provider event processed.
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
- Final lossless completed benchmark: 10 durable events, 3,913 payload bytes, 9 receipts, 12,288 bytes checkpointed DB growth, 3,688.72 ms elapsed, 73-byte transcript exact after a same-database reconnect.
- Final lossless interrupted benchmark: 10 durable events, 3,970 payload bytes, 9 receipts, 12,288 bytes checkpointed DB growth, 4,085.38 ms elapsed. The assistant transcript is journaled before volatile delivery; transcript, `interrupted` session state, and `interrupted` latest-turn state remain exact after reconnect. Independent reviewer sample: 4,416.31 ms with the same event/payload/receipt/DB results.
- Focused hard-kill, journal, ingestion, command/checkpoint lifecycle, provider adapter/registry/service, contract, projection, shell/client, logging, diagnostics, and HTTP tests all passed. The hard-kill case passed from both repository-root and `apps/server` package working directories.
- `vp check`: passed with zero errors and 10 pre-existing React warnings.
- `vp run typecheck`: passed across all 15 packages after the final fixes.
- Final bounded full suite (`vp test --maxWorkers 2 --maxConcurrency 1`): 603 files / 4,811 tests passed; 2 files / 7 tests skipped in 703.67 seconds.
- The first four-worker full-suite attempt exposed a real integration-harness identity mismatch plus aggregate-load Grok/registry timing failures. The harness now uses the same provider-instance acceptance binder as production; its 11 live tests then passed in 21.74 seconds, Grok and registry passed in isolation, and the stricter full suite passed.
- `vp run test`: passed across the complete package-script graph. Server: 175 files / 1,518 tests passed (2 files / 7 tests skipped); web: 154 files / 1,346 tests passed; all other package suites passed.
- `vp run lint:mobile`: passed the native source/static checks; SwiftLint, ktlint, and detekt were unavailable on `srv-2` and were explicitly skipped. Generated native project folders remained excluded.
- Independent critical review found no remaining release blocker after repeated hard-kill runs, 59 journal/ingestion/hard-kill tests, 34 Codex/contracts/journal tests, the 4-case instance-stamping test, and an independent interrupted benchmark. Its one low-risk journal lookup finding was fixed with leading `thread_id` indexes.
- Test portability stabilization: made BTRFS workspace expectations capability-aware and forced recursive-copy-specific tests onto a non-COW platform; expanded three import-heavy web test budgets and one ACP replay-start budget for full-suite contention. No production behavior changed in this stabilization.
- Headless server smoke: passed.
- Packaged Mac energy capture: explicitly deferred to final handoff.

### Lossless hard-kill correction — 2026-07-14

- Added an adapter-side SQLite write-ahead journal before the first volatile queue/`PubSub` offer. Codex, ACP/Cursor/Grok, Claude, OpenCode, and the deterministic adapter all declare `assistantTranscriptRecovery: "none"`; configured provider-instance identity is stamped before acceptance.
- Current providers durably dispatch every parent assistant delta and every subagent transcript change before retiring its exact journal identity. Only a future adapter with integration-tested authoritative parent-and-subagent recovery may use volatile transcript coalescing.
- Startup captures the live provider subscription before ordered journal recovery. Exact canonical identities are unique, item completion atomically closes acceptance for that scope, completed-item tombstones reject later new-ID traffic, and deterministic receipts make exact replay idempotent.
- Journal JSON is deliberately verbatim. The benchmark exposed and the fix now tests a trailing-newline corruption caused by schema normalization; the shared item lifecycle contract and Codex completion mapper also preserve assistant boundary whitespace.
- Persistence failures retry every 50 ms and increment `ingestion.activity.persistence_retries`; an adapter cannot return accepted while the journal commit is unavailable.
- Real hard-kill gate passed: after durable prefixes, journal-only suffixes were accepted but never offered for subagent, byte-identical post-approval parent, and active 24,001-byte parent cases. Immediate `SIGKILL` followed by a new runtime recovered all suffixes before replay; exact canonical replay did not duplicate bytes.
- The deterministic integration adapter now uses the production `bindProviderInstanceRuntimeEventAcceptance` seam. Direct journal wiring omitted the configured instance identity, producing a different durable key than the canonical `ProviderService` delivery and stalling live integration tests; the full lifecycle suite caught and closed this test/production-boundary mismatch.
- The hard-kill child fixture is resolved relative to `import.meta.url`, not `process.cwd()`, so the same real-process test runs under both the root `vp test` command and the package-local `vp run test` command.
- Independent critical review exercised crash durability, transcript exactness, replay, instance stamping, Codex fallback whitespace, and both benchmark terminal modes. All valid findings were fixed.
- Fresh lossless 9,200-chunk benchmarks are recorded above. The fallback adds one event, one receipt, 929/937 payload bytes, and one 4 KiB database page versus the unsafe volatile profile while retaining the command-output suppression gain.
- Final isolated headless boundary passed on `srv-2` using `agent-service` at `127.0.0.1:19374`: migration 37 ran, the process/socket stayed live, and `diagnostics workload --json` authenticated over HTTP and returned schema version 1 with every workload counter/gauge including `ingestion.activity.persistence_retries`. The source-headless `/` route returned the expected 503 because no static bundle or dev URL was configured; idle status reported zero busy work after shutdown.
- React Doctor `--diff` fell back to a repository-wide scan because the React optimization is already committed on `main`. Its 919 findings are pre-existing/migration-scale; the energy commit's exact Sidebar diff only removes detail prewarming, and the 132-test client matrix passed.
- Remaining release work: JJ split/commit, final origin/upstream fetch and reconciliation, outbound inspection, and push.

## Open Risks

- Projector cursor advancement still performs 11 cursor-row upserts, now inside one atomic transaction rather than 11 transactions.
- Cursor-only persistence is debounced. Abrupt process death inside the debounce can repeat an invisible replay tail, but cannot lose shell-visible state or corrupt the resume sequence.
- Provider log filenames changed from per-thread paths to globally bounded stream paths; external tooling needs migration.
- Provider event identity deduplication retains exact IDs only for unfinished/anonymous item or turn scopes, then collapses explicit items to completed-scope markers. A single unfinished scope therefore has memory proportional to its event count—the unavoidable cost of exact arbitrary-ID duplicate detection without a provider cursor. A semantically repeated delta with a newly invented provider event ID is treated as new only while the scope is unfinished; later traffic for an explicitly completed item is rejected.
- The WebSocket catch-up queue and history pages are bounded, but the shared upstream `PubSub` can still retain a live backlog while a slow subscriber replays history. A captured replay-tail boundary or sequence-addressable bounded broker is the follow-up architecture needed to close this fully.
- A provider that invents a new identity for semantically duplicated text remains ambiguous without a stable provider cursor. Exact old identities are suppressed by durable command receipts before hydrated state mutation.
- The stress harness has no shell or detail subscribers. Its zero shell/detail counters are only a harness fact; dedicated shell stream, client retention, and sidebar tests prove the inactive-detail boundary.
- Packaged-Mac long-task, process-energy, and post-settle memory validation remains the explicit final handoff.
- Hard-kill gate: the default Codex-kind path commits semantic suffixes to the journal without volatile delivery, is killed immediately, and recovers exact parent/subagent bytes before provider replay.
- Provider recovery audit remains unchanged: Codex, ACP/Cursor/Grok, Claude, and OpenCode do not currently supply authoritative parent-and-subagent recovery, so each declares `assistantTranscriptRecovery: "none"` and uses the durable semantic-delta fallback.
- Strict boundary: a semantic transcript event is accepted only after its verbatim canonical event commits to the SQLite journal. Projection publication follows with retry; only exact rows proven durable are removed. The hard-kill test proves abrupt process-death recovery, while host/power guarantees remain dependent on SQLite/filesystem/storage semantics.

## Current Results

- A scaled 96-chunk / 256-KiB pre-wave run produced 105 durable events and took 3.73 seconds, confirming near one-for-one raw-chunk amplification before the full baseline completed.
- The completed lossless profile recorded 9,200 unchanged activity suppressions, 3 semantic activity publications, 18 projector applications out of 110 candidates, and 4 deliberate full-history reads. Detail subscription/publication gauges remained zero and the subagent coalescer gauge returned to zero.
- Relative to the earlier unsafe volatile profile, losslessness adds one event, one receipt, 929/937 payload bytes, and one 4 KiB database page. Relative to baseline, completed execution remains 920.9x fewer events, 1,397x less DB growth, and 65.4x faster.
- Adversarial hardening replaced capacity/TTL-backed ingestion state with explicit lifecycle-owned maps, made transcript assembly lossless and item-aware without per-delta transcript rebuilds, strengthened activity/command identities, replaced the old 50,000-event window with lifecycle-scoped exact deduplication, made interruption use a real abort event, and verified interrupted turn state plus transcript replay through a newly constructed runtime rather than the original in-memory object.
