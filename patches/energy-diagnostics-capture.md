# Energy Diagnostics Capture

## Context

T3 Code can appear as a high Energy Impact app on macOS Activity Monitor, but ordinary app diagnostics only showed server-side child processes and trace counters. That left a blind spot for dev builds and packaged desktop builds: Electron renderer/main/helper processes, IPC pressure, renderer long tasks, and React commit activity were not collected in one artifact.

## Patch

This fork adds a developer-focused "Energy Capture" section to Settings -> Diagnostics. The capture is explicitly record-now rather than continuous telemetry.

The capture artifact includes:

- Electron `app.getAppMetrics()` process samples enriched with `webContents` metadata where available.
- Preload-side IPC pressure counters for bridge `invoke` and `sendSync` calls.
- Renderer long task samples through `PerformanceObserver` when supported by the engine.
- React `Profiler` commit samples for the app shell.
- Existing server trace, live process, and resource-history snapshots before and after the capture window.

Desktop captures write JSON artifacts under the desktop log directory in `energy-diagnostics/`. Browser-only captures still run but report desktop process and IPC data as unavailable.

## Maintenance Notes

- The contract surface lives in `packages/contracts/src/ipc.ts` so the preload, desktop main process, and web UI share the same bridge types.
- The Electron IPC handlers are intentionally narrow and only expose capture/read/write/reveal operations.
- IPC pressure is accumulated in the preload process because that is the shared bridge choke point for renderer-to-main calls.
- The UI is scoped to diagnostics/dev use; it is not intended to be an end-user performance report yet.

## Verification

Required baseline checks:

- `vp check`
- `vp run typecheck`

Manual verification should start a desktop build, open Settings -> Diagnostics, run a short Energy Capture, confirm a JSON artifact path appears, reveal the artifact, and inspect that it contains non-empty desktop process samples plus renderer/server sections.
