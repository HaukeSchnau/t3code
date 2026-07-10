# Diagnostics CLI Capture

## Goal

Allow agents and developers to trigger energy diagnostics from the shell against a running T3 Code app, without opening Settings manually.

## Current Plan

- Keep the existing renderer-owned capture as the source of truth for React commits and long tasks.
- Add a server-side diagnostics capture request broker.
- Add authenticated HTTP endpoints for CLI-triggered capture and status/result polling.
- Add WS/RPC methods for the renderer to subscribe to capture requests and report completion/failure.
- Add a root web consumer that runs `recordEnergyDiagnosticsCapture` when a request arrives.
- Add `t3 diagnostics energy` CLI command that prints JSON or a concise artifact summary.

## Decisions

- Do not use DevTools remote debugging as the primary control path.
- Do not make desktop main execute renderer JavaScript directly.
- Reuse existing server auth/session pattern from `t3 status idle`.
- Keep capture explicit and bounded; default to short record-now captures.

## Progress

- 2026-07-09: Synced upstream main in separate `merge: sync upstream main` change before feature work.
- 2026-07-09: Read-only subagent review agreed with brokered CLI -> server -> renderer architecture.
- 2026-07-09: Implemented contracts, server broker, authenticated HTTP endpoint, WS request/completion RPCs, root web consumer, and `t3 diagnostics energy`.
- 2026-07-09: Added broker unit tests for success, overlap rejection, timeout, and late completion.
- 2026-07-10: A real isolated dev-desktop run exposed a deferred WS-layer dependency bug. The WS route now captures the shared broker while constructing the route, and the existing authenticated WS handshake test guards the regression.
- 2026-07-10: Moved capture execution outside the React component body and made completion/failure command results explicit. Focused React Doctor scan is 100/100.
- 2026-07-10: Suppressed internal runtime logs for the diagnostics CLI so `--json` emits one parseable JSON document.
- 2026-07-10: Critical review identified multi-window races, reconnect publication loss, overly broad authorization, active-environment routing, and undersized wait timeouts.
- 2026-07-10: Added one-winner renderer claims, one-request replay, a dedicated administrative `diagnostics:capture` scope, primary-environment routing, schema-backed JSON failures, and duration-aware timeout validation.
- 2026-07-10: Final review found old desktop sessions without the new scope and two interruption/reconnect recovery gaps. Desktop auth now refreshes underscoped bootstrap sessions; renderer commands retry and release failed claims for republishing; interrupted broker requests clear pending state.
- 2026-07-10: Added an HTTP integration test proving standard paired sessions receive a `diagnostics:capture` scope error while the desktop administrative session reaches the capture broker.

## Verification

- Broker lifecycle suite: 8 tests covering success, failure, overlap, timeout, late completion, claim release/recovery, and interruption cleanup passed.
- Auth suites: 36 server/web tests passed, including automatic upgrade of a pre-feature desktop session.
- HTTP diagnostics authorization integration test passed for both standard and administrative sessions.
- Authenticated WS route regression: `vp test apps/server/src/server.test.ts -t "accepts websocket rpc handshake with a bootstrapped browser session cookie"` passed.
- Fresh isolated dev-desktop CLI capture completed with an artifact containing fresh before/after server snapshots, 30 resource-history buckets, desktop process and IPC snapshots, 11 IPC channels, and renderer commits. A warm 1-second capture completed in 3.26 seconds including CLI startup.
- Concurrent CLI invocation exited 1 with `status: "rejected"`; the original four-second capture completed with 3 desktop samples, 3 IPC samples, 11 IPC channels, and 3 renderer commits.
- Invalid `999ms` duration exited 2 with the expected validation error.
- `vp run typecheck` passed.
- `vp check` passed with 17 pre-existing warnings outside this change.
- Focused React Doctor scan passed at 100/100.
- Complete `vp test` suite passed: 595 files and 4,753 tests passed; 2 files and 7 tests were skipped.
- No mobile/native files are changed, so `vp run lint:mobile` is not required.

## Production Diagnosis

2026-07-10, packaged macOS build `0.0.28` using the real `~/.t3/userdata` state:

- The packaged CLI is functional through Electron's Node mode, but no `t3` executable is installed on
  `PATH`. The working invocation is the app executable plus
  `Contents/Resources/app.asar/apps/server/dist/bin.mjs diagnostics energy ...`.
- A 30-second capture during a runaway command-output stream recorded 121 renderer long tasks totaling
  9.77 seconds. The renderer reached roughly 1.8-2.3 GB and was frequently near or above one CPU core.
- The trigger was an `rg -a` command that treated application binaries as text and emitted 9,187 Codex
  `item/commandExecution/outputDelta` notifications, about 22.4 MB, in the capture window.
- `ProviderRuntimeIngestion.updateSubagentActivity` publishes a full `subagent.thread` activity for every
  subagent runtime event, even when command-output events change neither transcript, status, nor last
  activity. This turns provider chunk rate directly into orchestration write rate.
- Every activity/message event refreshes thread-shell summary state by loading complete per-thread message,
  plan, activity, and approval collections. The hot thread's refreshes measured roughly 40-100 ms each.
- The shell stream converts every thread aggregate event into `thread-upserted`. The client replaces the
  shell snapshot, rebuilds thread indexes/groupings, and invalidates sidebar derivations for inactive-thread
  updates.
- The sidebar additionally opens live full-detail subscriptions for its first ten visible threads. The hot
  thread was second-most-recent and therefore prewarmed. Each activity update filters and sorts its complete
  activity history, and a 500 ms debounce JSON-encodes the complete thread snapshot into IndexedDB.
- Native and canonical provider streams are both logged by default. Provider logs occupied about 1.8 GB;
  rotated server traces occupied about 107 MB and amplified serialization and disk IO during the flood.
- `state.sqlite` was about 5.8 GB with 1.91 million orchestration events. The dominant payloads were 472,539
  `thread.activity-appended` rows totaling about 2.0 GB and 1,427,905 `thread.message-sent` rows totaling
  about 601 MB.
- An old packaged server process remained orphaned under PID 1 after restart. It had no listener and low
  current CPU, but retained memory and had accumulated about 30 minutes of CPU time.
- A final 15-second settling capture with no child reviewer running recorded three long tasks totaling
  284 ms. This establishes that event ingestion is the dominant multiplier rather than a permanent tight
  renderer loop, although idle renderer/GPU work and periodic VCS/provider polling remain follow-up targets.

Artifacts retained under `~/.t3/userdata/logs/energy-diagnostics/`:

- `energy-capture-2026-07-10T15-10-34-385Z.json`: runaway output stream.
- `energy-capture-2026-07-10T15-15-45-111Z.json`: assistant streaming after the command completed.
- `energy-capture-2026-07-10T15-31-27-033Z.json`: settling baseline.

Recommended fix order:

1. Do not publish unchanged subagent activities; coalesce meaningful transcript/status updates at a bounded
   cadence and avoid storing repeated cumulative transcript snapshots.
2. Remove live sidebar detail prewarming or replace it with one-shot bounded snapshot prefetching.
3. Emit shell updates only when shell-visible fields change.
4. Make thread reducers incremental and bound/defer full-thread IndexedDB persistence.
5. Disable, sample, or explicitly enable native/canonical provider payload logs and high-frequency traces.
6. Add retention/compaction for orchestration events and provider logs, then repair orphan server cleanup.
7. Add source-attributed renderer CPU/heap profiling and subscription-owner counters to the diagnostics CLI.
