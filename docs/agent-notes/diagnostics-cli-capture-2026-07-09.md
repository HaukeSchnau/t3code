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
