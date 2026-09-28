# Mobile remote debugging

## Goal

Keep the physical iPhone dev loop against remote T3 Code environments (the MacBook and `srv-2`)
repeatable through `agent-device` and a one-time pairing URL.

## Requirements

- Provide root `Justfile` recipes for physical iOS and desktop install workflows:
  - `just mobile-dev`
  - `just mobile-prod`
  - `just mobile-dev-server`
  - `just mobile-dev-open`
  - `just mobile-dev-reload`
  - `just mobile-dev-snapshot`
  - `just desktop-macos`
- Keep web and Metro as independent native devenv processes with their own managed endpoints.
  Both depend on the shared dependency task. `project dev up` and `devenv up` use this definition.
- Desktop artifact packaging must resolve `vp` through the workspace-local `node_modules/.bin/vp`
  executable so `just desktop-macos` works in non-interactive shells where `vp` is not on `PATH`.
- Default physical-device settings are local to this fork and must be overridable with environment
  variables such as `T3CODE_IOS_DEVICE`, `T3CODE_APPLE_TEAM_ID`,
  `T3CODE_AGENT_DEVICE_IOS_BUNDLE_ID`, `T3CODE_AGENT_DEVICE_SESSION`, and
  `T3CODE_MOBILE_METRO_HOST`.
- Keep pairing URLs out of committed state and logs. Treat them as credentials.
- Use the shared Project Runtime's `project-context` interface for the `web` and `mobile` Endpoint
  listeners, URLs, and Checkout/State/Cache paths. The web adapter must run the existing
  single-origin `scripts/dev-runner.ts dev` graph with a runtime-selected Vite port and origin, keep
  `VITE_HTTP_URL` and `VITE_WS_URL` unset, and place T3 Code data below per-Instance State. The mobile
  adapter remains repository-owned Expo/Metro. Persistent supervision, local listener allocation,
  manifest validation, Preparation locking, and hostname publication do not belong to either adapter.
- Keep shared requirements and release policy in `project.nix`, consumed independently by the
  production flake. Generate development metadata from native devenv annotations.
- In dev builds, let the Add Environment screen prefill and optionally auto-connect from
  `EXPO_PUBLIC_T3CODE_DEV_PAIRING_URL` and `EXPO_PUBLIC_T3CODE_DEV_PAIRING_AUTOCONNECT`. Route
  params for the pairing URL and auto-connect let external automation deep-link into the same flow.
- Prefer snapshots and Metro logs as primary physical-device verification. `agent-device network
dump` can be empty unless log capture has been explicitly started.

## Upstream touch points

- `Justfile`
- `flake.nix`
- `scripts/build-desktop-artifact.ts`
- `apps/mobile/README.md`
- `apps/mobile/src/features/connection/ConnectionsNewRouteScreen.tsx`

## Non-goals

- Do not make the fork's personal device names or Apple Team ID upstream defaults.
- Do not rely on physical-device text entry for the fast debug loop when a one-time pairing URL is
  available.

## Verification

- `vp run lint:mobile` when changing native or mobile code.
- Physical-device smoke test with `just mobile-dev-open`, `just mobile-dev-reload`, and
  `just mobile-dev-snapshot`.
