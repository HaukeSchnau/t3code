# High-Cardinality Session Energy Optimization

## Context

Long-running provider sessions previously amplified raw runtime chunks into durable activities, projection transactions, shell upserts, inactive thread-detail reductions, cache serialization, and full provider payload logs. A representative 9,200-chunk / 22 MiB command-output replay produced 9,209 durable events, grew checkpointed SQLite state by 17,166,336 bytes, and took 241.38 seconds on `srv-2` even though only a few semantic lifecycle and transcript changes were visible.

This is fork-specific behavior. Preserve these requirements during upstream syncs:

- Raw provider chunk count must not dictate durable event count.
- Transcript bytes and lifecycle state must remain exact through completion, interruption, reconnect, duplicate delivery, and replay.
- Inactive threads must not own full-detail subscriptions or perform detail reduction/persistence.
- Shell subscribers update only for shell-visible changes while retaining an exact replay cursor.
- Default provider logs must be globally bounded and must not retain payload values.

## Patch

### Provider ingestion

- Provider command IDs are derived from provider event identity and semantic command identity, including per-message/per-activity IDs where one provider event can produce several commands. The in-memory duplicate ledger is scoped by active item and turn: exact event identities are retained while an item can still affect transcript state, then collapsed to completed item/turn identities. No-op subagent command-output identities are not retained because replaying them is the same no-op.
- Subagent state is keyed by parent T3 thread, provider kind and instance, and child provider thread. Command-output chunks that do not change transcript, summary, or status are suppressed before detail lookup.
- Pending subagent state uses an explicit lifecycle-owned map, so capacity or TTL eviction cannot silently lose transcript bytes. Transcript assembly is lossless and item-aware: streamed segments append to item-local segment arrays in constant time, while a nonempty item-completed detail authoritatively replaces only that item's streamed value. The cumulative transcript is materialized only at durable publication.
- Meaningful transcript/status changes publish a consolidated `subagent.thread` activity. The first state and lifecycle transitions publish immediately; ordinary deltas use a deterministic 500 ms event-time coalescing window.
- Pending subagent state flushes on parent completion, interruption/abort, runtime error, session exit, ingestion drain, and layer finalization.
- Buffered assistant text remains byte-exact and terminal finalization uses message-specific idempotency keys.

### Projections and reducers

- The projection pipeline routes each event only to projectors that handle it, then advances all projector cursors in one atomic transaction. Mixed-cursor bootstrap retains its replay semantics.
- Common shell summary changes are applied from the current event. Streaming assistant deltas do not touch the shell-carried latest-turn projection; the completed message updates it once. Full history reconciliation remains only for true history mutations such as revert/prune.
- Shell and thread reducers use last-item/update-by-ID fast paths and incremental insertion rather than cloning, filtering, and sorting whole histories for each delta.

### Shell and inactive detail

- `shellVisibility.ts` is the shared server boundary for events that can change a shell summary. Invisible events become sequence-only cursor items without loading a thread shell.
- Cursor frames are capability-gated (`includeCursorItems`) so old clients never receive the new union member. New clients keep the resume cursor outside reactive shell state; cursor-only bursts are compacted every 128 events and persisted through the existing sliding/debounced cache writer.
- Catch-up subscribes to live events before reading history, reads history in bounded pages, and drains through a bounded live catch-up queue. Client sequence deduplication removes overlap, preserving reconnect correctness.
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
| Durable events               |         9,209 |               9 |                 9 |
| Durable payload bytes        |     4,667,304 |           2,984 |             3,033 |
| Command receipts             |         9,208 |               8 |                 8 |
| Checkpointed DB growth       |  17,166,336 B |         8,192 B |           8,192 B |
| Elapsed                      | 241,383.13 ms |     4,515.96 ms |       4,370.73 ms |
| Exact replay after reconnect |           yes |             yes |               yes |

The completed after-profile recorded 9,200 unchanged activity suppressions, 2 semantic activity publications, 17 projector applications out of 99 candidates, 4 deliberate full-history reads, and all lifecycle-owned coalescer gauges returning to zero. The interrupted variant adds a dirty assistant transcript delta and then aborts the parent turn; it records one coalesced update and one terminal flush, and both the session and latest turn rebuild as `interrupted`. Both variants dispose the first runtime, build a fresh runtime and projection layer against the same SQLite database, and compare the rebuilt transcript and complete event-range hash byte-for-byte.

The fixture intentionally has no shell or detail subscriber, so its zero shell/detail counters are not evidence for inactive-subscription behavior. Dedicated WebSocket, shell-state, sidebar, and retention tests establish that boundary separately.

## Maintenance risks

- Adding a new event that changes a shell field requires updating both the relevant projector handler and `shellVisibility.ts`, with a focused shell-stream test.
- Cursor-only persistence is deliberately debounced rather than awaited during scope teardown. A process killed inside that debounce may replay an already-seen invisible tail after restart; sequence deduplication keeps this correct and server compaction bounds downstream work.
- Duplicate delivery with the same provider event identity is exact while its item/turn remains active and after completion through compact completed-scope markers. Memory is proportional to the current unfinished semantic scope rather than all raw output in a long-lived session. A single unfinished or anonymous assistant item still necessarily retains its event identities until a terminal/finalizer boundary; exact arbitrary-ID duplicate detection cannot be bounded independently of that in-flight scope. Within an active unfinished scope, a provider-invented new identity for semantically identical bytes must be treated as new because no provider cursor proves duplication. Once an explicit item is completed, later traffic for that completed item scope is rejected even under a new identity.
- The WebSocket catch-up queue and history pages are bounded, but the shared upstream live-event `PubSub` remains unbounded. A subscriber that cannot drain while history is replayed can therefore retain an upstream backlog; eliminating that residual requires a captured replay-tail boundary or a sequence-addressable bounded broker.
- If an activity dispatch fails after an in-memory transcript segment is accepted, the dirty state is retained for terminal/drain retry. A provider that then replays the same semantic bytes under a new event identity before that retry can append them again; a stable provider cursor is required to disambiguate that case without risking byte loss.
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

Focused coverage lives beside ingestion, projection, shell visibility/WebSocket, contracts, client shell/reducers, provider logging, workload diagnostics/CLI/HTTP, and the integration fixture. A real headless server can be checked with:

```sh
node apps/server/src/bin.ts diagnostics workload \
  --base-dir "$T3CODE_HOME" \
  --dev-url http://127.0.0.1:13773 \
  --json
```
