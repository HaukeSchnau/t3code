# Reconnect and large-history recovery, 2026-07-17

## Current status

- The reconnect/lazy-history implementation is committed and pushed on T3 `main` at
  `914e6f0892de`. srv-2 is running that revision from
  `/nix/store/lq6s1chari6qjjiwc7g3q9zay9z8jxrl-t3code-0.0.28`.
- Infra `main` pins the deployment in `2f8fbc42bdca`. `just verify-host srv-2` passed and the
  deferred restart identity is applied with no pending cutover.
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

## Live deployment verification

- The deferred idle gate selected the cutover without manually signalling provider processes. The
  process changed from PID `1679086` to `2263029`; the new service is active with zero automatic
  restarts and local HTTP returns 200.
- Production migrations 41, 42, and 43 completed successfully in **13.9 seconds**. The service began
  listening 0.85 seconds later with provider transcript recovery complete and no failed batches.
- The pre-deploy browser tab retained the old JavaScript bundle and continued issuing legacy
  full-history reconnects. A single post-deploy reload moved it to the compact client and removed
  the reconnect banner; do not diagnose this stale-bundle behavior as a server regression.
- Fresh worst-thread browser measurement (`e9295b7e-137c-4508-b2ae-d295951e59b2`): interactive
  composer in **1.847 seconds**, 2.09 MB total cold resource transfer including all application
  assets, historical 70-minute turn expansion in **227 ms**, collapse in **106 ms**, and re-open in
  **107 ms**. The existing master thread became interactive in **3.191 seconds** after its bundle
  refresh. No browser console exceptions occurred; one unrelated missing-resource 404 remains.
- The old server passed the application idle check but did not exit within systemd's 90-second stop
  timeout and required SIGKILL. The database and new process recovered cleanly, but bounded,
  observable provider/session shutdown is a follow-up reliability issue.

## Next actions

1. Investigate why the idle old process could not complete SIGTERM shutdown within 90 seconds;
   instrument the remaining handles and enforce a bounded provider/session close sequence.
2. Resolve the unrelated missing-resource 404 observed by Chrome if it is reproducible and identify
   whether it is a favicon/manifest request or an application asset.
3. From the committed revision on the Mac, build/install T3 Code Desktop and run its desktop smoke
   test. This remains deferred until the srv-2 commit/deploy handoff is complete.
