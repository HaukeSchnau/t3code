# Energy Diagnostics Tooling

## Goal

Implement record-now diagnostics that make high macOS Energy Impact debuggable on Hauke's machine and in dev builds.

## Scope

- Primary target: local desktop/dev builds, including packaged macOS and `node --run dev:desktop`.
- Capture mode: explicit short recordings, not continuous background telemetry.
- Artifact goal: enough structured data for an agent or developer to drill from "T3 Code is hot" to likely process, renderer, IPC, or server causes.

## Implemented Shape

- Desktop main process exposes energy diagnostics IPC methods:
  - Capture Electron process metrics.
  - Write a JSON capture artifact into the desktop log directory.
  - Reveal the capture artifact in Finder.
- Preload wraps desktop bridge IPC calls and accumulates message pressure counters.
- Web diagnostics recorder captures:
  - Desktop process snapshots.
  - IPC pressure snapshots.
  - Renderer long tasks.
  - React Profiler commits for the app shell.
  - Existing server trace/process/resource diagnostics before and after the capture.
- Settings -> Diagnostics exposes an Energy Capture section with 30s, 60s, and 5m recording buttons.

## Assumptions

- This is intentionally developer tooling first; polish and interpretation can follow after we collect real artifacts from problem sessions.
- Browser-only use should degrade gracefully by capturing renderer/server data without desktop process or IPC samples.
- Existing server diagnostics remain the source of truth for child agent process attribution.

## Verification Plan

- Run formatting/check/typecheck.
- Start the desktop app manually.
- Open Settings -> Diagnostics.
- Run a short capture.
- Confirm the UI reports a saved artifact.
- Inspect the artifact JSON for desktop, renderer, server, and recurring-work sections.

## Verification Result

2026-07-08:

- `vp check` passed with only pre-existing mobile schema-compile warnings.
- `vp run typecheck` passed.
- Started `T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT=9333 node --run dev:desktop`.
- Used the real Electron renderer at `t3code-dev://app/#/settings/diagnostics`.
- Ran the visible 30s Energy Capture button.
- UI reported `Status = Ready`, `Artifact = Saved`, `Desktop Samples = 150`, `Renderer Commits = 44`, `Long Tasks = 7`, and `IPC Channels = 10`.
- Inspected `/Users/haukeschnau/.t3/dev/logs/energy-diagnostics/energy-capture-2026-07-08T21-19-08-110Z.json`:
  - `schemaVersion = 1`
  - `durationMs = 30000`
  - `desktop.available = true`
  - 30 process snapshots with Electron process types including Browser, GPU, Utility, and Tab
  - 30 IPC pressure snapshots with 10 counters
  - 44 renderer commits and 7 renderer long tasks
  - recurring sampler tick count 30 with failure count 0
  - server after-snapshot included process diagnostics and resource history

## Follow-Up Ideas

- Add lightweight ranking in the UI/artifact summary for top CPU, top IPC channel, longest renderer task, and heaviest React commit.
- Add a tiny command-palette action to start a 30s capture from anywhere.
- Add capture annotations so the user can mark what they were doing while recording.
- Add a background guardrail that detects unexpectedly high IPC rate during dev and suggests running a capture.
