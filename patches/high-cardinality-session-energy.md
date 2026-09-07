# High-cardinality session energy

## Scope and status

This patch records the fork requirements for provider sessions that emit many small runtime
chunks. The old V1 coalescing implementation and its hard-kill integration harness have been
removed. Native V2 now has a durable provider-event journal and startup replay path. The V1
measurements near the end of this document are historical evidence for why these constraints
exist. They are not a native V2 performance result.

The requirements are:

- Command-output chunk rate must not determine durable event, projection, shell-update, or
  subscription work. Durable writes should represent semantic state changes.
- Accepted provider state must survive completion, interruption, reconnect, duplicate delivery,
  replay, and process loss without losing or duplicating transcript and lifecycle state.
- Inactive threads must not retain full-detail subscriptions or perform detail reduction and
  persistence.
- Shell consumers must update for shell-visible changes while retaining an exact sequence cursor.
- Default provider logs must be globally bounded and contain metadata rather than payload values.

## Native V2 acceptance and replay

`ProviderSessionManager` gives each V2 adapter an `acceptEvent` callback. The adapter awaits that
callback before its event enters volatile ingestion. `ProviderEventJournal` stores the typed V2
event, provider session and instance identity, owning thread, and entity identity in
`provider_event_journal`. It hashes a stable JSON envelope for the journal identity. SQLite
uniqueness suppresses an exact duplicate, and a terminal message or turn-item snapshot rejects later nonterminal snapshots for
that entity, including across replacement sessions. Terminal enrichment remains allowed. A storage or encoding failure prevents acceptance, so the
volatile queue cannot get ahead of durable intake.

`ProviderEventIngestorV2` normalizes an accepted provider event into V2 domain events and carries
the accepted journal ID to `EventSinkV2`. Inside one SQL transaction, the sink appends the event
store rows, applies projections, advances projection metadata, retires the accepted journal row,
and enqueues effects. Retiring an entity also retires older snapshots for that entity. If the
transaction rolls back, the journal row remains pending for replay.

`ProviderEventJournalReplay.ts` reads pending rows in sequence order and bounded pages. It skips
rows already retired during the scan, handles shared-session thread ownership, and sends the rest
through the same ingestor. Server startup runs this replay before provider runtime recovery, so
provider workers cannot produce new events ahead of accepted rows left by an intake failure.

EventSink live subscriptions use a sliding wake marker. Markers may collapse, but committed
events remain in the indexed event store and consumers resume by sequence. This is a notification
optimization, not a replacement for exact catch-up.

The native journal stores schema-encoded V2 events, preserving their transcript strings including
leading and trailing whitespace. It does not archive the original provider wire-format JSON.

## Correctness evidence

The focused native tests cover these boundaries:

- `EventSinkJournal.test.ts` replays an accepted event after an intake crash and keeps the journal
  pending when projection work rolls back.
- The same test file rejects an exact duplicate after retirement, retires older snapshots when a
  newer entity snapshot commits, and replays durable message and subagent snapshots exactly once.
- Shared provider-session replay resolves a provider turn to its projected owning thread.
- `ProviderEventJournal.test.ts` covers stable identity deduplication, terminal entity guards,
  ordered pending reads, and retirement of older snapshots.

These tests establish the journal and projection transaction boundary. They do not establish a
native V2 timing, database-growth, or high-cardinality throughput number.

## Shell, detail, and projection constraints

High-cardinality output still needs the fork's consumer-side limits. Native shell projection and
subscription behavior must keep cursor-only events resumable without loading thread detail. Catch-up must subscribe before reading history, read bounded pages, and reconcile
the persisted sequence with the live tail. Full-detail subscriptions should be released when an
inactive thread leaves the visible surface.

The deterministic energy fixture has no shell or detail subscriber. Its zero shell/detail work
therefore says nothing about those limits. Keep their focused shell, WebSocket, retention, and
client reducer tests separate from the provider-journal tests.

Adding an event that changes a shell field requires the matching native projector and
subscription updates. A provider event with a new identity but identical text cannot be
classified as a duplicate without a provider cursor. Suppressing it would risk deleting valid
repeated text, so native V2 currently relies on provider identity and terminal entity state rather
than semantic text deduplication.

## Full detail on demand

The normal wire projection bounds large command output, file changes, dynamic-tool values, and
subagent detail. Web, desktop, and mobile can fetch the full native item when the user expands
its detail. `getTurnItems` accepts exact item IDs scoped to the owning thread, so imported items
without a provider turn remain accessible and opening one item does not load the whole turn.
The server reads the indexed native projection without applying transport truncation.

## Provider logging

Native and canonical provider logs use separate global files, `native.log` and `canonical.log`.
Each active stream is limited to a 2 MiB file plus two backups, or about 6 MiB per stream. Default
records contain bounded event identity and shape metadata, never payload values or arbitrary
payload key names. High-frequency records are sampled; lifecycle and error records are retained.

The aggregate retention guard remains 512 MiB. Older per-thread files are left in place during the
path migration so the new global streams do not eagerly delete legacy diagnostics. Age and
aggregate retention still remove stale files, which means the complete log directory can exceed
the roughly 12 MiB occupied by the two current global streams while legacy files remain.

## Historical V1 benchmark

The old benchmark was measured on `srv-2` on 2026-07-13. It used the removed V1 file-backed
orchestration harness. The table is retained as a historical baseline only. It must not be read as
evidence that native V2 has these timings or storage bounds.

The deterministic generator in
`apps/server/integration/energyAmplification.integration.test.ts` still fixes the input shape:

- 9,200 command-output chunks
- 23,068,672 bytes, SHA-256
  `fba6dd53ee07a034f5807278fb9938893f652b6bb96782959cbeeabacd1e6fb0`
- final transcript of 73 bytes, SHA-256
  `5d6b773121f298070d5e1af3ef4986a722c3c21f71fa065dae9b6e279d1f5566`

| Metric | V1 before | V1 completed profile | V1 interrupted profile |
| --- | ---: | ---: | ---: |
| Durable events | 9,209 | 10 | 10 |
| Durable payload bytes | 4,667,304 | 3,913 | 3,970 |
| Command receipts | 9,208 | 9 | 9 |
| Checkpointed database growth | 17,166,336 B | 12,288 B | 12,288 B |
| Elapsed time | 241,383.13 ms | 3,688.72 ms | 4,085.38 ms |
| Exact replay after reconnect | yes | yes | yes |

The fixture test currently checks deterministic input hashes and generated event count. It does not
run this persistence benchmark. No comparable native V2 performance run is recorded here.

## Process-loss boundary

The former `coalescingHardKill.integration.test.ts` gate belonged to the removed V1 harness. The
native V2 replacement is the accepted-event journal boundary: after acceptance, a process loss
leaves the row for startup replay; after projection and journal retirement commit together, replay
does not apply the event a second time. The focused journal tests exercise this transaction and
replay behavior without claiming host or storage-device failure durability.

## Maintenance notes

- Keep provider identity and entity identity stable across adapter changes. A new identity for old
  text is not safely deduplicable.
- Keep journal acceptance ahead of volatile adapter delivery. Do not reintroduce an in-memory
  transcript coalescer whose recovery cursor is weaker than its live path.
- Keep shell visibility, cursor, inactive-detail, and log-retention changes covered by their own
  focused tests. The energy fixture cannot prove them.
- Treat the V1 table as a regression reference until a native V2 benchmark records the same input,
  workload, database-growth, and replay measurements.

