# Claudex provider integration

## Goal

Ship Claudex as a reusable T3 Code fork feature: it is always present in provider settings, enabled by default, and uses Claude Code's interface with `gpt-5.6-sol` through the host-provided `claudex` executable.

## Decisions

- Model Claudex as a bundled provider instance, not a new provider driver. It reuses the existing `claudeAgent` driver and adapter.
- Give bundled instances one generic source of truth so future fork-provided profiles do not require one-off UI or settings migrations.
- Claudex instance ID: `claudex`; display name: `Claudex`; accent: orange.
- Default configuration: `binaryPath: "claudex"`, shared Claude home (`homePath: ""`), built-in model discovery disabled, and `customModels: ["gpt-5.6-sol"]`.
- A bundled provider may be enabled or disabled and otherwise edited, but cannot be deleted. Missing bundled instances are restored when settings are projected into the runtime or UI; existing user overrides win.
- Add `includeBuiltInModels` to Claude instance configuration. It defaults to `true`, preserving stock Claude behavior; Claudex sets it to `false` so its picker contains only its configured proxy model.
- Claudex shares Claude's config and skills, but uses a distinct T3 continuation group so native
  Claude sessions cannot resume through the routed runtime.

## Workstreams

1. Contracts: define bundled instance metadata/defaults and settings normalization.
2. Server: honor `includeBuiltInModels` when constructing Claude model snapshots.
3. Web: mark bundled cards as non-deletable while retaining the enable toggle and other settings.
4. Tests/docs: cover migration, catalog behavior, and UI policy; document the fork patch and Claude option.
5. Infrastructure: package the Claudex runtime for macOS and Linux, run CLIProxyAPI on srv-2, expose the executable and skills to T3 Code, deploy, and verify.

## Verification plan

- Focused contract, provider registry/model, and settings UI tests.
- Repository-required `vp check` and `vp run typecheck`.
- On srv-2: systemd health, loopback proxy probe, T3 provider snapshot, and a real Claudex prompt.

## Current status

- Isolated jj workspace created at `/Users/haukeschnau/Code/t3code-claudex` from `main`.
- Bundled provider projection, Claude model filtering, non-deletable settings behavior, tests, and fork documentation are implemented.
- Follow-up cleanup in August 2026 narrowed proxy behavior to the explicit Claudex instance and
  restored the wrapper-level authoritative auth probe after an upstream merge had dropped it.
- Focused verification: 128 tests passed across contracts, provider registry, settings persistence, and web instance projection.
- Repository gates: `vp check` passed with no errors (pre-existing warnings remain); `vp run typecheck` passed all 15 packages.
- Next: commit/push T3 Code, then implement and deploy the srv-2 runtime contract from `~/infra`.

## Assumptions and operational note

- `claudex` is supplied by the machine configuration and is intentionally not bundled into the application package.
- A separate one-time CLIProxyAPI Codex device login on srv-2 is preferred over copying Codex's refresh token: independent refresh-token owners can invalidate each other. Existing Codex authentication remains untouched.
