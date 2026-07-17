# Reconnect recovery, 2026-07-17

## Active goal

Make srv-2 reconnects responsive under a multi-thread monitor workload, then commit, build, deploy,
and measure the verified runtime. Build/install the desktop app separately on the Mac.

## Current live state

- The deployment hold is lifted: Composer, Claudex, and Sonnet completed; GLM was explicitly
  interrupted; master emitted its final response and then stopped.
- The current Playwriter shell is stable.
- The reconnect patch bounds client thread catch-up to three concurrent synchronizations per RPC
  session; synchronized subscriptions remain live without retaining a permit.

## Completed and committed work

- Nix build-performance commit `eb0b572ad327` splits web, server, runtime dependencies, and final
  assembly into independently cached derivations. Detailed results are in
  `agent-notes/build-performance/2026-07-17-nix-build.md`.
- Persistent diff-worker commit `8a5c94c3abbd` keeps the worker pool above thread-route remounts.
- Local snapshot single-flight commit `1f5df6292705` is complete and pending push.

## Rejected and removed work

- Transcript batching commit `d4c52069e120` was removed and was not pushed after crash-consistency
  review. Sealing 32 rows under one command identity could acknowledge `e1`, then drop `e2` through
  `e32` as duplicates after a crash, so it is not a completed fix.

## Ready to commit and deploy: `wip: bound reconnect catch-up work`

- Durable RPC subscriptions now support an Effectful input factory sampled on every replacement
  session and every expected-failure retry while preserving the static APIs.
- Thread detail reconnects sample the latest applied sequence rather than retaining the initial
  cache/snapshot cursor.
- Opt-in admission uses a weak per-`RpcSession` semaphore with three permits. It releases on the
  first synchronization marker and idempotently on failure/interruption. Limits are validated,
  same-group conflicts fail explicitly, and queued acquisition remains interruptible.
- No server snapshot files were changed. No deployment or service restart has been performed.

## Measured before and after

- Cursor regression before: a cached sequence 7 followed by applied event 8 subscribed with
  `[7, 7]` across both session replacement and expected-failure retry.
- Cursor behavior after: both paths subscribe with `[7, 8]`.
- Reconnect fan-out before: all eight active detail streams could start catch-up concurrently.
- Reconnect fan-out after: deterministic admission is 3/3/2, for a measured peak of 3; all eight
  streams remain live after synchronization.
- Existing srv-2 snapshot observations were 18–25 seconds while the service cgroup held 423 tasks
  and 4.37 GiB across provider subprocesses. This WIP addresses reconnect amplification, not that
  independent provider-load baseline.

## Verification status

- Thread synchronization suite: 15/15 passing.
- RPC client suite: 16/16 passing, including validation/conflict failures, retry finalization,
  queued cancellation, duplicate synchronization, and replacement-session gates.
- `@t3tools/client-runtime` typecheck passes; one pre-existing suggestion remains in
  `src/relay/discovery.ts`.
- Focused combined suites pass 31/31. `vp check` passes with 0 errors and 15 unrelated existing
  warnings after its output was captured locally on srv-2 to avoid SSH stdout pressure.
- Full `vp run typecheck` passes.
- Independent review is approved; all hardening findings and final evidence gaps are resolved.
- The patch is ready to commit, push, build, deploy, and measure.

## Next deploy steps

1. Commit and push the reconnect patch as its own atomic change.
2. Build the cached srv-2 closure from the committed revision.
3. Deploy the srv-2 closure, smoke-test connection/reconnect behavior, and compare replay
   counters and visible recovery latency.
4. As a separate Mac follow-up, build/install the T3 Code Desktop app from the verified revision;
   the prior all-work-on-srv2 constraint does not permit completing that platform-specific build on
   srv-2.
