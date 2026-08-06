# Mobile Remote Debugging And Reconnects

## Goal

Keep the physical iOS mobile app usable with remote T3 Code environments, especially the personal
MacBook and `srv-2` environments, while making the dev-client feedback loop repeatable through
`agent-device`.

## Source Context

- Backfilled from the current fork delta against `main@upstream`.
- Session archive thread `019e8226-b495-7aa3-aef5-ab84625ef793` recorded the mobile debugging
  context: MacBook Desktop to `srv-2` worked, mobile to MacBook needed HTTPS/DNS support, mobile
  to `srv-2` was unreliable, and the workflow switched to dev builds plus `agent-device` for faster
  iteration.
- That session's final notes recorded three requirements that still exist in code: dev-only
  pairing helper, capability-gated terminal metadata subscription, and transient handling for
  stream/remote-close transport errors after a ready connection.

## Requirements

- Provide root `Justfile` recipes for physical iOS and desktop install workflows:
  - `just mobile-dev`
  - `just mobile-prod`
  - `just mobile-dev-server`
  - `just mobile-dev-open`
  - `just mobile-dev-reload`
  - `just mobile-dev-snapshot`
  - `just desktop-macos`
- Provide repository-owned `.#dev`, `.#dev -- --only metro`, and `.#dev-metro` Nix entry points for
  supervised or local Metro development.
- Desktop artifact packaging must resolve `vp` through the workspace-local `node_modules/.bin/vp`
  executable so `just desktop-macos` works in non-interactive shells where `vp` is not installed
  globally or present on `PATH`.
- Default physical-device settings are local to this fork and must be overridable with environment
  variables such as `T3CODE_IOS_DEVICE`, `T3CODE_APPLE_TEAM_ID`,
  `T3CODE_AGENT_DEVICE_IOS_BUNDLE_ID`, `T3CODE_AGENT_DEVICE_SESSION`, and
  `T3CODE_MOBILE_METRO_HOST`.
- Keep pairing URLs out of committed state and logs. Treat them as credentials.
- Consume `PROJECT_RUNTIME_FILE` for the Metro endpoint, listener, state, cache, and checkout paths.
  Persistent supervision and Tailnet ingress belong to the declarative host Project, not an imperative
  `agent-service` preview. Local invocation without a manifest may use the repository's loopback
  defaults.
- Export the versioned repository-owned Project descriptor as both `project.json` and `lib.project`.
  Infrastructure evaluates the descriptor and `packages.<system>.projectRuntime` from its pinned flake
  input to infer Preparation, Workloads, Endpoints, and readiness. It must never evaluate the mutable
  checkout or an ad-hoc worktree during reconciliation.
- In dev builds, allow the Add Environment screen to prefill and optionally auto-connect from
  `EXPO_PUBLIC_T3CODE_DEV_PAIRING_URL` and `EXPO_PUBLIC_T3CODE_DEV_PAIRING_AUTOCONNECT`.
- Also support route params for pairing URL and auto-connect so external automation can deep-link
  into the connection flow.
- Defer saved-environment lifecycle/config side subscriptions until the shell snapshot has
  bootstrapped. This prevents stale lifecycle/config events from winning before the primary shell
  state is ready.
- On shell resubscribe for saved environments, reset the bootstrap gate and stop side
  subscriptions until the new shell snapshot arrives.
- Preserve cached shell snapshots during reconnect attempts so the mobile UI remains useful while
  the connection is pending.
- Treat transport-close messages from a previously ready connection as reconnecting/transient
  rather than sticky disconnected errors when they match known connection-loss strings.
- Reconnect saved environments on app resume when the heartbeat is stale, with a short cooldown to
  avoid reconnect storms.
- Gate terminal metadata subscriptions behind the server capability bit to support mobile clients
  newer than older remote servers.
- Prefer snapshots and Metro logs as primary physical-device verification. `agent-device network
dump` can be empty unless log capture has been explicitly started.

## Upstream Touch Points

- `Justfile`
- `flake.nix`
- `scripts/build-desktop-artifact.ts`
- `apps/mobile/README.md`
- `apps/mobile/src/app/connections/new.tsx`
- `apps/mobile/src/state/use-remote-environment-registry.ts`
- `packages/client-runtime/src/environmentConnection.ts`
- `packages/client-runtime/src/transportError.ts`

## Non-Goals

- Do not make the fork's personal device names or Apple Team ID upstream defaults.
- Do not rely on physical-device text entry for the fast debug loop when a one-time pairing URL is
  available.
- Do not require the remote server to support newer optional capabilities before connecting.

## Verification

- `vp run lint:mobile` when changing native/mobile code.
- `packages/client-runtime/src/transportError.test.ts`
- Physical-device smoke test with `just mobile-dev-open`, `just mobile-dev-reload`, and
  `just mobile-dev-snapshot`.
- Manual remote checks: saved environment shows `Connected`, project list renders, refresh does not
  leave sticky disconnected errors.
- Required repo gates: `vp check` and `vp run typecheck`.
