# Energy Diagnostics Capture

## Context

T3 Code can appear as a high Energy Impact app on macOS Activity Monitor, but ordinary app diagnostics only showed server-side child processes and trace counters. That left a blind spot for dev builds and packaged desktop builds: Electron renderer/main/helper processes, IPC pressure, renderer long tasks, and React commit activity were not collected in one artifact.

## Patch

This fork adds a developer-focused "Energy Capture" section to Settings -> Diagnostics. The capture is explicitly record-now rather than continuous telemetry. Agents and developers can also trigger the same renderer-owned capture from the shell with `t3 diagnostics energy`.

The capture artifact includes:

- Electron `app.getAppMetrics()` process samples enriched with `webContents` metadata where available.
- Preload-side IPC pressure counters for bridge `invoke` and `sendSync` calls.
- Renderer long task samples through `PerformanceObserver` when supported by the engine.
- React `Profiler` commit samples for the app shell.
- Existing server trace, live process, and resource-history snapshots before and after the capture window.

Desktop captures write JSON artifacts under the desktop log directory in `energy-diagnostics/`. Browser-only captures still run but report desktop process and IPC data as unavailable.

The CLI path is brokered through the running server:

- `t3 diagnostics energy` issues a short-lived administrative session, calls `POST /api/diagnostics/energy-capture`, and waits for a structured result.
- The server publishes a single in-flight capture request over WebSocket RPC.
- The primary local environment's authenticated web app subscribes at the root route, claims the request, runs the existing renderer/desktop recorder, and reports completion or failure back over WebSocket RPC.
- The CLI exits nonzero for rejected, failed, or timed-out captures and supports clean `--json` output for agent-readable automation.

For headless amplification analysis, `t3 diagnostics workload --json` reads cumulative process-local counters and active-work gauges from the authenticated server. It complements the bounded renderer capture: workload counters explain how provider input fans out into durable events, projection work, shell/detail publications, and provider log bytes without requiring macOS or Electron.

Capture RPCs require the administrative `diagnostics:capture` scope. Requests use a one-item replay buffer so a renderer that subscribes just after publication still sees the pending work. A per-request claim token ensures only one of multiple windows can record or settle a capture. Explicit wait timeouts must include the capture duration plus a 15-second completion allowance.

Renderer settlement commands are retried to tolerate brief WebSocket reconnects. If completion or failure still cannot reach the server, the renderer releases its claim and the broker republishes the request so another connected window can recover it. Interrupted HTTP requests also clear their pending broker entry. Existing desktop sessions created before the `diagnostics:capture` scope was introduced are automatically refreshed from the desktop bootstrap credential.

## Maintenance Notes

- The contract surface lives in `packages/contracts/src/ipc.ts` so the preload, desktop main process, and web UI share the same bridge types.
- The Electron IPC handlers are intentionally narrow and only expose capture/read/write/reveal operations.
- The CLI trigger surface lives in `packages/contracts/src/diagnostics.ts`, `apps/server/src/diagnostics/EnergyCaptureRequests.ts`, `apps/server/src/cli/diagnostics.ts`, and the root web consumer.
- The claim token is intentionally returned only to the winning diagnostics subscriber and is required on both completion and failure reports.
- Claim release is restricted to the current claim token and returns the request to the unclaimed state before republishing it.
- IPC pressure is accumulated in the preload process because that is the shared bridge choke point for renderer-to-main calls.
- The UI is scoped to diagnostics/dev use; it is not intended to be an end-user performance report yet.
- Workload counters reset at server startup and are intentionally diagnostic state rather than persisted telemetry. Their implementation and benchmark contract are documented in `patches/high-cardinality-session-energy.md`.

## Verification

Required baseline checks:

- `vp check`
- `vp run typecheck`

Manual verification should start a desktop build, open Settings -> Diagnostics, run a short Energy Capture, confirm a JSON artifact path appears, reveal the artifact, and inspect that it contains non-empty desktop process samples plus renderer/server sections.

For CLI verification, start a dev or packaged desktop app and run:

```sh
t3 diagnostics energy --duration 5s --json
```

When targeting a development instance with an isolated home, include the same home and dev URL used to launch it:

```sh
t3 diagnostics energy \
  --base-dir "$T3CODE_HOME" \
  --dev-url http://127.0.0.1:5733 \
  --duration 5s \
  --json
```

Confirm the command returns `status: "completed"` with an artifact path and nonzero sample counts when desktop diagnostics are available.
