# Mobile distribution

## Fork requirement

Every green commit on the fork's `main` must reach Hauke's iPhone without manual steps, and fork
builds must never run JavaScript from upstream's Expo project. Upstream updates can replace
fork-only behavior such as accountless connections and native agent awareness.

## Implementation

- `.gitea/workflows/mobile.yml` runs after CI succeeds on `main`. It queues rather than cancels,
  so a newer push never kills an in-flight TestFlight build.
- `scripts/mobile-update.ts` resolves the Expo fingerprint once on Linux CI and publishes the
  bundle as a static Expo Updates (protocol v1) update. The `t3code-ci` runners on srv-2 write
  to the directory behind `https://t3code-updates.schnau.dev`. Infra's
  `modules/features/t3/mobile-updates.nix` serves it and grants that access.
- `scripts/mobile-testflight.ts` runs on the m1 Apple builder. It uploads a production build
  only when no current TestFlight build carries the same runtime version, or when the last one
  nears TestFlight's 90-day expiry. Each build's "What to Test" note records its runtime. The job
  uses the builder's Xcode, CocoaPods and Node (pnpm through corepack): this flake's older
  nixpkgs Node and CocoaPods break on macOS 27.
- Both jobs pass the Linux-resolved runtime version through `T3CODE_MOBILE_RUNTIME_VERSION`.
  Fingerprints can differ between hosts, so the binary and its updates must share one value.
- `apps/mobile/app.config.ts` enables Expo Updates only when `T3CODE_MOBILE_UPDATES_URL` is set.
  Local and dev builds keep running only their embedded bundle.
- App Store Connect: app "T3 Code Schnau" (`dev.schnau.t3code`, team `2243J9RD68`) with the
  internal TestFlight group "Hauke", which receives every build. The m1 runner provides the team's
  API key through `APP_STORE_CONNECT_API_KEY_*`. Xcode manages signing through that key.
- Force a new binary with the Mobile workflow's manual `force_testflight` input.

## Maintenance

Keep the update URL fork-owned during upstream merges; upstream's `u.expo.dev` URL must not return.
The static host and the qemu-wrapped Hermes compiler exist because srv-2 is aarch64 and
`hermes-compiler` ships only an x86-64 Linux binary. Remove that workaround when upstream ships
linux-arm64 builds. This patch could shrink to configuration if the fork adopted EAS Update with
its own Expo project, at the cost of an external service and build quota.
