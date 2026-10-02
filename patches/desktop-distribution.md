# Desktop distribution

## Fork requirement

Every green commit on the fork's `main` must reach Hauke's MacBook as a signed desktop build that
updates itself and keeps its macOS permissions across updates. Fork builds must never read update
metadata from GitHub. Upstream's desktop releases (GitHub releases, Developer ID, T3 Connect
passkeys) don't apply to the fork.

## Implementation

- `.gitea/workflows/desktop.yml` follows CI the way `mobile.yml` does: Kiln's `apple` step dispatches
  it with the tested revision and a build number once a push to `main` passed and was promoted. Its
  Package job builds and signs the app on the m1 Apple builder, and
  its Publish job writes it to the feed from srv-2. CI never waits for m1, so a paused or busy
  builder delays only the desktop build, and a desktop failure never turns CI red or skips the
  mobile update. A newer green commit cancels an older desktop build.
- Builds are versioned `<version>-schnau.<CI run number>` (`github.event.workflow_run.run_number`)
  with `scripts/update-release-package-versions.ts`. electron-updater only installs a strictly
  higher version, and CI's run number only grows. It also continues the numbering of the builds
  made while the desktop jobs ran inside CI.
- Signing uses Urbs UG's Apple Development identity from the runner's login keychain
  (`CSC_NAME`), without notarization. Gatekeeper only checks notarization on quarantined files.
  curl and the updater don't quarantine, so installs go through `scripts/desktop-install.sh`
  rather than a browser download.
- `T3CODE_APPLE_TEAM_ID` gives the main bundle a team-based designated requirement
  (`scripts/sign-macos.ts`). macOS permissions, keychain access and Squirrel's signature check
  then survive certificate renewals and a later move to Developer ID.
- `scripts/build-desktop-artifact.ts` sets the app id `dev.schnau.t3code.desktop`, apart from
  the iOS app, which Apple Silicon Macs can also run. The product name is "T3 Code Schnau"
  (`apps/desktop/package.json`). The in-app name stays "T3 Code (Alpha)": Electron names the
  safeStorage keychain entry after it, and renaming would strand saved environment tokens.
- The publish config is a generic feed from `T3CODE_DESKTOP_UPDATE_URL`. Upstream's
  `GITHUB_REPOSITORY` fallback is gone: Gitea sets it to `schnau/t3code`, and
  `github.com/schnau` is an unrelated account. Signed builds add T3 Connect passkey entitlements
  only when a provisioning profile is configured.
- `scripts/desktop-publish.ts` runs on the `t3code-ci` runners and writes into
  `T3CODE_DESKTOP_UPDATES_DIR`. Infra's `modules/features/t3/mobile-updates.nix` serves it at
  `https://t3code-updates.schnau.dev/desktop/`, Tailnet only. The zip lands before
  `latest-mac.yml` moves, release notes are the first-parent subjects since the previous build,
  and the newest three builds stay.
- The app downloads updates on its own and only asks to restart (`DesktopUpdates.ts`). It follows
  the channel its version implies rather than a stored preference, and Settings no longer offers
  the Stable/Nightly track.
- `just desktop-macos` runs the install script. Local unsigned installs are gone: each had a new
  code identity, so macOS asked for permissions after every install and the updater could not
  work.

## Maintenance

Keep the fork identity, feed and signing through upstream merges. Upstream's GitHub publish
config and mandatory passkey signing must not return. `CSC_NAME` changes if the App Store
Connect key `85N8Y9CZC4` is replaced. Moving to Developer ID with notarization only changes the
workflow, keeps the update chain thanks to the team requirement, and would allow browser
downloads. Drop the pinned channel and hidden picker if the fork ever publishes a second feed.
