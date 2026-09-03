# High-Cardinality Session Energy Optimization

## Context

Long-running provider sessions previously amplified raw runtime chunks into durable activities, projection transactions, shell upserts, inactive thread-detail reductions, cache serialization, and full provider payload logs. A representative 9,200-chunk / 22 MiB command-output replay produced 9,209 durable events, grew checkpointed SQLite state by 17,166,336 bytes, and took 241.38 seconds on `srv-2` even though only a few semantic lifecycle and transcript changes were visible.

This is fork-specific behavior. Preserve these requirements during upstream syncs:

- Raw provider chunk count must not dictate durable event count.
- Transcript bytes and lifecycle state must remain exact through completion, interruption, reconnect, duplicate delivery, replay, and abrupt process loss after ingestion acceptance.
- Inactive threads must not own full-detail subscriptions or perform detail reduction/persistence.
- Shell subscribers update only for shell-visible changes while retaining an exact replay cursor.
- Default provider logs must be globally bounded and must not retain payload values.

## Patch

### Provider ingestion

- Provider command IDs are derived from provider event identity and semantic command identity, including per-message/per-activity IDs where one provider event can produce several commands. The in-memory duplicate ledger is scoped by active item and turn: exact event identities are retained while an item can still affect transcript state, then collapsed to completed item/turn identities. No-op subagent command-output identities are not retained because replaying them is the same no-op.
- Subagent state is keyed by parent T3 thread, provider kind and instance, and child provider thread. Command-output chunks that do not change transcript, summary, or status are suppressed before detail lookup.
- Pending subagent state uses an explicit lifecycle-owned map, so capacity or TTL eviction cannot silently lose transcript bytes. Transcript assembly is lossless and item-aware: streamed segments append to item-local segment arrays in constant time, while a nonempty item-completed detail authoritatively replaces only that item's streamed value. The cumulative transcript is materialized only at durable publication.
- Before any current adapter offers a semantic assistant event to a volatile queue or `PubSub`, it commits the canonical event to `provider_transcript_journal`. The configured provider-instance identity is stamped before this acceptance gate. Exact identities are unique in SQLite, item completion is ordered atomically with deltas, and later deltas for a completed item are rejected before acceptance.
- Journal JSON is stored and loaded verbatim rather than decoded through normalizing provider schemas. This is required for byte-exact whitespace; a trailing-newline regression test guards the boundary. Startup captures the live provider subscription first, replays journal rows in commit order, then consumes the captured live tail.
- Every current adapter declares `assistantTranscriptRecovery: "none"`. On this path each accepted parent delta enters the durable journal before volatile delivery. Ingestion seals the rows accepted during one display frame into a persisted deterministic projection batch; every subagent transcript change still durably publishes a `subagent.thread` activity. The exact source rows retire only after the projection is durable. Transient persistence failures retry with bounded spacing instead of being logged and dropped.
- Volatile transcript coalescing remains available only behind `assistantTranscriptRecovery: "authoritative"`. An adapter may opt in only after an integration-tested replay cursor or recovered snapshot supplies byte-exact parent and subagent transcripts before live events resume. Ordinary non-transcript activity changes may still use the deterministic 500 ms event-time window.
- Durable activities carry compact transcript item boundaries and the last provider event identity. A restarted ingestion layer hydrates its item-aware assembler from this projection, while durable command receipts reject exact provider replay before it can mutate hydrated state. This preserves continuation without overwrite and replay without duplicated bytes.
- Pending subagent state flushes on parent completion, interruption/abort, runtime error, session exit, ingestion drain, and layer finalization.
- Buffered assistant text is reachable only behind authoritative recovery. Approval, user-input, item, turn, runtime-error, and session-exit boundaries finalize it with message-specific idempotency keys.

### Projections and reducers

- The projection pipeline routes each event only to projectors that handle it, then advances all projector cursors in one atomic transaction. Mixed-cursor bootstrap retains its replay semantics.
- Coordination activity reads use bounded `kind` ranges instead of SQLite's default case-insensitive `LIKE`. The range predicates seek the existing binary `kind` index rather than scanning the full activity projection as long-running histories grow.
- Common shell summary changes are applied from the current event. Streaming assistant deltas do not touch the shell-carried latest-turn projection; the completed message updates it once. Full history reconciliation remains only for true history mutations such as revert/prune.
- Shell and thread reducers use last-item/update-by-ID fast paths and incremental insertion rather than cloning, filtering, and sorting whole histories for each delta.

### Shell and inactive detail

- `shellVisibility.ts` is the shared server boundary for events that can change a shell summary. Invisible events become sequence-only cursor items without loading a thread shell.
- Cursor frames are capability-gated (`includeCursorItems`) so old clients never receive the new union member. New clients keep the resume cursor outside reactive shell state; cursor-only bursts are compacted every 128 events and persisted through the existing sliding/debounced cache writer.
- Catch-up subscribes to live events before reading history, reads history in bounded pages, and drains through a bounded live catch-up queue. Client sequence deduplication removes overlap, preserving reconnect correctness.
- Unary replay plus shell and thread catch-up share one low-overhead observation lifecycle. Metrics and structured completion logs expose the persisted tail, pages/batches, events scanned before filtering, replay items emitted, duration, live-buffer high-water mark, and buffered overlap that clients dedupe. Metric labels contain only the bounded flow and outcome dimensions; project, thread, command, and event identifiers are deliberately excluded. Failure and interruption finalize the same observation so stalled or cancelled train-network reconnects remain measurable.
  Finalization performs only a fixed number of in-memory metric/counter updates on the handoff path. Structured logs enter one supervised capacity-128 dropping queue, so a slow log sink cannot delay the bounded live buffer or create per-replay fibers; overflow is counted, and server-scope shutdown deliberately discards diagnostic-only records still queued.
- Warm shell and thread reconnects use a bounded payload-free SQLite probe before choosing their catch-up representation. Small ranges retain exact event replay. A thread range beyond 256 events or 2 MiB and a shell range beyond 1,024 events or 4 MiB prefer a current projection snapshot, then replay every persisted event after that snapshot's sequence. The live subscription is still buffered before the probe/snapshot read, and client sequence deduplication still settles persisted/live overlap. A snapshot is never allowed to replace a client cursor at the same or a newer sequence, and a missing thread snapshot falls back to exact replay. This keeps projection lag, deletion races, ordering, and crash recovery correct while collapsing legacy token-amplified histories to one current state plus a small tail.
- Sidebar detail prewarming is removed. Thread-detail atoms use an idle TTL of zero so navigation/offscreen teardown drops the last full-detail subscription immediately. Deliberately visible Monitor tiles remain detail consumers.

### Logging and observability

- Native and canonical provider logs use distinct global files. Each stream is capped at a 2 MiB active file plus two backups (about 12 MiB total across both streams).
- Default records contain bounded event identity and shape metadata, never payload values or arbitrary payload key names. High-frequency events retain the first eight records and every 256th; lifecycle/error records are not sampled.
- Process-local workload counters expose provider chunks/characters, semantic suppression/publication, durable events, projection work/history reads, shell upserts/cursors, detail publications, log sampling/bytes, and active subscription/coalescer gauges.
- Authenticated `GET /api/diagnostics/workload` and `t3 diagnostics workload --json` expose a point-in-time profile. Counters reset with the server process and are intentionally not durable telemetry.

## Deterministic benchmark

Run the file-backed SQLite fixture from the repository root:

```sh
node apps/server/scripts/energy-amplification-benchmark.ts --terminal completed
node apps/server/scripts/energy-amplification-benchmark.ts --terminal interrupted
```

Fixture identity:

- 9,200 canonical command-output deltas
- 23,068,672 bytes, SHA-256 `fba6dd53ee07a034f5807278fb9938893f652b6bb96782959cbeeabacd1e6fb0`
- final transcript: 73 bytes, SHA-256 `5d6b773121f298070d5e1af3ef4986a722c3c21f71fa065dae9b6e279d1f5566`

Measured on `srv-2` on 2026-07-13:

| Metric                       |        Before | Completed after | Interrupted after |
| ---------------------------- | ------------: | --------------: | ----------------: |
| Durable events               |         9,209 |              10 |                10 |
| Durable payload bytes        |     4,667,304 |           3,913 |             3,970 |
| Command receipts             |         9,208 |               9 |                 9 |
| Checkpointed DB growth       |  17,166,336 B |        12,288 B |          12,288 B |
| Elapsed                      | 241,383.13 ms |     3,688.72 ms |       4,085.38 ms |
| Exact replay after reconnect |           yes |             yes |               yes |

The completed lossless profile recorded 9,200 unchanged activity suppressions, 3 semantic activity publications, 18 projector applications out of 110 candidates, 4 deliberate full-history reads, and all lifecycle-owned gauges returning to zero. The interrupted variant durably publishes its assistant delta before the parent abort and then records one terminal flush; both the session and latest turn remain `interrupted` after reconnect. Both variants dispose the first runtime, open a fresh runtime against the same persisted projection tables, compare the 73-byte transcript hash, and compare a deterministic semantic hash of event type, occurrence time, and payload. This is a same-database reconnect check, not a projection-table rebuild or a byte hash of every encoded event field.

Relative to the earlier unsafe volatile-coalescing profile, strict durability costs one event, one receipt, 929 bytes of completed payload / 937 bytes of interrupted payload, and one 4 KiB SQLite page in this fixture. Relative to baseline, the completed path uses 920.9 times fewer durable events, 1,397 times less checkpointed DB growth, and 65.4 times less elapsed time. These results are expected because the pathological 22 MiB is command output, while the only semantic assistant transcript is 73 bytes.

The fixture intentionally has no shell or detail subscriber, so its zero shell/detail counters are not evidence for inactive-subscription behavior. Dedicated WebSocket, shell-state, sidebar, and retention tests establish that boundary separately.

## Abrupt process-loss gate

`apps/server/integration/coalescingHardKill.integration.test.ts` starts the default Codex-kind deterministic adapter against a real file-backed orchestration runtime in a child process. It first projects durable prefixes, then commits three suffixes through the adapter acceptance gate without offering them to the volatile delivery queue: a subagent suffix, a post-approval parent suffix byte-identical to the completed prefix, and a suffix for an active 24,001-byte parent message. The parent sends `SIGKILL` immediately after the ready marker. A newly constructed runtime recovers every suffix from SQLite before provider replay, normal completion produces the exact expected messages, and replay of old canonical identities plus terminal delivery does not duplicate transcript bytes.

The strict guarantee begins when a semantic assistant event returns accepted from an adapter declaring `assistantTranscriptRecovery: "none"`: its byte-exact canonical representation has already committed to SQLite before any volatile offer. Ingestion then durably dispatches each current-provider parent delta or subagent transcript state and retires only the exact journal identities proven durable. Abrupt process termination after acceptance cannot lose the accepted bytes; restart replays retained rows in commit order. Host/power-failure durability additionally depends on SQLite, filesystem, and storage-device commit semantics and is not established by the `SIGKILL` test. Storage that cannot commit backpressures acceptance and increments `ingestion.activity.persistence_retries`. A future authoritative adapter may coalesce only within its separately integration-tested parent-and-subagent snapshot/replay guarantee.

## Maintenance risks

- Adding a new event that changes a shell field requires updating both the relevant projector handler and `shellVisibility.ts`, with a focused shell-stream test.
- Cursor-only persistence is deliberately debounced rather than awaited during scope teardown. A process killed inside that debounce may replay an already-seen invisible tail after restart; sequence deduplication keeps this correct and server compaction bounds downstream work.
- Duplicate delivery with the same canonical provider identity is rejected at the journal and again by deterministic command receipts. Completed-item tombstones reject later traffic for that item even under a new identity and are deleted with their owning thread. Within an active item, semantically identical text carrying a genuinely new canonical identity is indistinguishable from legitimate repeated text; suppressing it without a provider cursor would itself lose valid transcript bytes. Current providers expose no authoritative native replay, and the hard-kill test covers exact canonical replay.
- The WebSocket catch-up queue and history pages are bounded, but the shared upstream live-event `PubSub` remains unbounded. A subscriber that cannot drain while history is replayed can therefore retain an upstream backlog; eliminating that residual requires a captured replay-tail boundary or a sequence-addressable bounded broker.
- Provider duplication under a newly invented event identity remains indistinguishable from genuinely new text while an item is active. Exact identity replay is suppressed durably; semantic deduplication without a stable provider cursor would risk deleting legitimate repeated text.
- Full subagent activity snapshots remain proportional to current-provider semantic transcript changes. Parent assistant deltas use persisted frame batches, so provider token fragmentation no longer creates one orchestration transaction per fragment. A future specialized durable subagent delta event could reduce cumulative snapshot payload amplification if subagent streams become a measured bottleneck.
- Projector cursor advancement still performs one row upsert per projector inside the single transaction. This is no longer transaction amplification, but a future schema change could batch the cursor rows.
- Provider log paths changed from per-thread files to global `native.log` and `canonical.log`; external diagnostic tooling must use the new paths. Old files are not deleted.
- Full payload provider capture is intentionally unavailable by default. Any future payload capture must be explicit, time/size bounded, and documented in the diagnostics patch.

## Verification

Required gates:

```sh
vp check
vp run typecheck
vp test
vp run test
```

Focused coverage lives beside ingestion, projection, shell visibility/WebSocket, contracts, client shell/reducers, provider logging, workload diagnostics/CLI/HTTP, and the integration fixture. Run the abrupt-loss gate with:

```sh
vp test apps/server/integration/coalescingHardKill.integration.test.ts
```

This focused gate uses a real child process, file-backed SQLite, `SIGKILL`, and a newly constructed runtime; it does not mock process loss.

A real headless server can be checked with:

```sh
node apps/server/src/bin.ts diagnostics workload \
  --base-dir "$T3CODE_HOME" \
  --json
```

The final `srv-2` verification ran the source server against an isolated home on port 19374, observed migration 37 and a live TCP socket, and received the authenticated schema-version-1 diagnostics response with all counters and gauges. A source server without a packaged static directory or dev URL returns 503 at `/`; that expected headless response is separate from the authenticated diagnostics API.

Final release gates on 2026-07-14: `vp check` passed with zero errors, all 15 typecheck packages passed, the bounded full suite passed 603 files / 4,811 tests with 2 files / 7 tests skipped, the package-script graph passed (server: 175 files / 1,518 tests with 2 files / 7 tests skipped), and native-mobile static checks passed while unavailable macOS-only lint binaries were explicitly skipped on `srv-2`.
