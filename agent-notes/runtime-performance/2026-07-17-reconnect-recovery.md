# Reconnect and large-history recovery, 2026-07-17

## Current status

- The final reconnect/lazy-history WIP on srv-2 is approved and ready to commit, push, build, and
  deploy. No commit, push, deployment, or service restart has been performed for this WIP yet.
- Independent review is approved with no remaining blocking findings.
- The T3 Code Desktop build/install remains a separate Mac task after the verified revision is
  committed. It is intentionally deferred because the platform-specific desktop build cannot be
  completed on srv-2.

## Final design

- Reconnect catch-up samples the latest applied cursor on every replacement/retry and admits at most
  three thread synchronizations per RPC session. Permits release at the synchronization marker and
  subscriptions remain live afterward.
- Thread activity snapshots now have explicit `full` and `compact` modes. Full remains the default
  and is used by internal/mobile consumers; the web client explicitly requests compact snapshots.
- Compact snapshots keep thread-scoped, latest-turn, active-turn, and every `turn.plan.updated` and
  `subagent.thread` activity hot. Each other turn is represented by one constant-size descriptor.
  Promoted plan/subagent rows are excluded from descriptors and hydration, making hot and hydratable
  sets disjoint.
- Historical turn payloads are fetched on demand with revision/byte metadata, single-flight client
  hydration, cursor preservation, and keyed reconciliation. Unchanged polling does not replace
  historical branch-detail DOM.
- Activity revisions use the outer orchestration event sequence. Revert/prune events restamp all
  retained activities/groups, including no-removal events. Existing activity IDs have immutable
  thread/turn membership, enforced by a NULL-safe SQLite trigger; same-membership updates remain
  valid.
- Persisted `payload_bytes` and `display_activity` metadata avoid JSON/blob/window scans. Exact
  per-turn and thread-wide NULL-last expression indexes cover canonical reads. Migration 43 also
  idempotently repairs databases that recorded the earlier revision-only WIP migration 42.

## Quantitative results

- Worst production-shaped thread: 16,804 activities and 33,315,725 payload bytes.
- Compact hot set: 336 activities and 1,743,049 payload bytes, a 94.77% payload reduction.
- Historical descriptors: 30,332 bytes for 139 turns versus 2,077,970 bytes of prior per-activity
  metadata, a 98.54% reduction.
- Worst-thread descriptor query: 428–476 ms before; 43–53 ms after, approximately 8–11x faster and
  below the 100 ms target.
- Exact full repository read for the same 16,804-row thread: 205–343 ms warm before (260 ms median;
  one cold 4.115 s run) versus 99–115 ms after (106 ms median), a 59.2% median reduction / 2.45x
  speedup. The final plan uses the thread-wide covering index with no temporary ORDER BY B-tree.
- Production-sized migration 41+42 benchmark: 7.329 s and +15,282,176 bytes. Transient WAL allocation
  was 227,625,912 bytes plus 458,752 bytes of shared memory and was reclaimed after checkpoint/close.
- Current-schema migration 43 benchmark: 575 ms and +11,173,888 bytes. The earlier revision-only WIP
  42 repair path took 8.279 s and +12,533,760 bytes.
- Expected first production startup migration window from migration 40 is approximately 8–10 seconds.
  The server does not begin serving until migration completes. SQLite WAL readers may continue, but
  writers wait for the startup write transaction. Allow roughly 230 MB of temporary WAL headroom.

## Final verification

- Full test suite: **5,248/5,248 passed**.
- Static gates: `vp check` passed and `vp run typecheck` passed.
- Focused migration, repository, projection, hydration, reconnect, liveness, membership, and query
  plan regressions all pass, including production/WIP upgrade paths and no-op prune/revert parity.
- Independent reviewer disposition: **approved**.

## Next actions

1. Commit the reviewed WIP as an atomic change and push `main`.
2. Build and deploy the committed srv-2 closure. Expect the one-time 8–10 second startup migration
   window, then smoke-test connect/reconnect, compact snapshots, historical hydration, and provider
   liveness using live counters and visible latency.
3. From the committed revision on the Mac, build/install T3 Code Desktop and run its desktop smoke
   test. This remains deferred until the srv-2 commit/deploy handoff is complete.
