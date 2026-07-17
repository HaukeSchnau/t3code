# Lazy Historical Activity Hydration

## Purpose

Keep large thread histories responsive by excluding historical activity payloads from the base
thread snapshot. Tool output payloads can dominate a thread even when the corresponding turns are
collapsed in the timeline.

## Contract

- Full detail is the backward-compatible default for HTTP and WebSocket thread snapshots. Web
  clients explicitly request `activityDetailMode=compact`; the echoed snapshot mode prevents a
  cache produced for one mode from satisfying the other.
- Internal `getSnapshot()` and `getThreadDetailById()` queries remain full and lossless.
- Compact `thread.activities` contains lossless activities needed immediately: thread-scoped
  activities, activities for the thread's latest turn, activities for the session's active turn,
  every `subagent.thread` record, and every `turn.plan.updated` record. Promoting those semantic
  activities to the hot set keeps orchestration status available without hydrating a collapsed turn.
- Superseded null-turn `context-window.updated` snapshots are omitted because their consumer
  intentionally reads only the canonical latest snapshot. Other null-turn activity kinds remain
  lossless.
- `thread.historicalActivityGroups` contains one constant-size descriptor per other turn:
  activity/display counts, payload byte size, first/last time anchors, and a revision. The base
  snapshot is therefore O(turns), not O(activities). Descriptors and turn hydration exclude the
  promoted plan/subagent records, so the compact hot and hydratable fold sets are disjoint.
- Activity revisions use the outer orchestration event sequence, not the optional provider activity
  sequence. Same-id payload/metadata updates therefore invalidate hydration even when provider
  sequence is absent. Every persisted revert/prune event re-stamps retained rows with the mutation
  event sequence, including events whose filters retain every row, so server descriptors and client
  groups advance under the same authoritative revision rule.
- Activity identity has immutable membership: once an `activity_id` is stored, its `thread_id` and
  nullable `turn_id` cannot change. Migration 43 installs a null-safe SQLite trigger that aborts
  membership-changing updates while allowing same-membership payload/revision upserts. This keeps
  compact hot/historical classification correct without sending an O(activities) ID manifest.
- `GET /api/orchestration/threads/:threadId/turns/:turnId/activities` returns every non-promoted
  activity for one valid turn with its original payload, revision, payload byte size, and a
  transactionally consistent projection sequence. The promoted plan/subagent records are already in
  the compact hot set and are not duplicated by hydration.
- Canonical activity order is `(sequence IS NULL, sequence, created_at, activity_id)`, placing
  unsequenced activity after sequenced activity exactly like the client reducer. Per-turn and
  thread-wide reads are covered by matching expression indexes.
- `activity_revision`, UTF-8 `payload_bytes`, and `display_activity` are persisted on each projection
  row. Descriptor aggregation therefore reads indexed scalar metadata without parsing JSON,
  measuring payload blobs, or using window functions. Migration 42 backfills legacy rows once;
  repository upserts maintain the metadata in O(1).
- Migration 43 idempotently repairs development databases that recorded the earlier revision-only
  WIP migration 42: it inspects the table schema, adds/backfills only missing metadata columns,
  normalizes legacy index names, and installs the thread-wide canonical-order index. Databases with
  the current migration 42 preserve existing metadata values.
- Descriptor time anchors select the first/last canonical display activity so folded rows align with
  the entries hydration will render. All-hidden turns fall back to their canonical non-promoted
  activity anchors to preserve the descriptor's non-null ordering contract.

## Verification

- Projection query tests cover full/internal versus compact/network semantics; null/latest/active
  classification; production-shaped plan/subagent retention; mixed sequenced/unsequenced ordering;
  same-id unsequenced revision invalidation; lossless hydration; and missing turns.
- The repository parity test verifies null-last ordering independently from the query layer. The
  upgrade test verifies the exact expression-index query plan and lossless legacy UTF-8 byte/display
  metadata backfill, including databases that previously ran the superseded development migration
  41 index.

## Maintenance

Retain this patch until upstream supports bounded base snapshots plus lossless on-demand activity
hydration. Do not replace it with silent payload truncation: historical tool details must remain
available through the per-turn endpoint.
