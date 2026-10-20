# NixOS CI portability

Calder runs the fork's checks on loaded NixOS aarch64 workers. Upstream's CI runs on Ubuntu and macOS, so a few
upstream tests and one wrapper script assume an FHS system: tools under `/bin` and `/usr/bin`, a coreutils
that is a set of separate programs, dash as `/bin/sh`, x86-64 or Apple silicon, and English tool messages.

## What the fork changes

- `flake.nix` (`devShells.ci`): `LC_ALL=C.UTF-8`, because the workers inherit the host's German locale and
  tests match English Git messages. It also adds `jujutsu` for the jj workspace tests, and on Linux points
  `T3CODE_BROWSER_TEST_CHROMIUM` at nixpkgs' Chromium for the web browser tests, because the Chromium
  Playwright downloads does not run on NixOS.
- `apps/desktop/src/wsl/DesktopWslEnvironment.test.ts`: the busy-runtime holder renames a shell instead of
  `cat`. A multi-call coreutils picks its program from argv[0].
- `apps/web/src/reactCompilerCoverage.test.ts`: 300 s per file instead of 120 s. Compiling `ChatView.tsx`
  takes over 20 s on an idle srv-2 and ran past 120 s on a loaded Calder worker.
- `packages/shared/src/nodeSqliteClient.test.ts`: the large-parameter test binds a raw `ArrayBuffer` only
  when Node can. nixpkgs' Node 24.15 binds it as NULL; the newer Node 24 release upstream's CI picks binds it. Drop the
  check once nixpkgs ships that release.
- `packages/provider-acp/src/server/clientTerminals.test.ts`: the Devin shell test passes PATH in the session
  environment, which replaces the inherited one.
- `packages/provider-opencode/src/server/OpenCodeServerLedger.test.ts`: Linux runs the macOS `ps` path only
  where `/bin/ps` exists.
- `apps/server/src/orchestration-v2/Adapters/AcpRegistryAdapterV2.test.ts`: the registry fixture also lists
  `linux-aarch64`.
- `apps/server/src/mcp/OrchestratorMcpToolkit.integration.test.ts`: the fake provider binds a turn's
  terminal gate before the turn is observable, and the fan-out case waits for the first delivery turn
  before swapping gates. On a loaded worker the run reported running first, the swap won, and the
  delivery waited on the next gate until the test timed out.
- `apps/desktop/src/snapShot/LinuxSnapShot.dbus.test.ts` and `PortalCaptureShortcut.dbus.test.ts`: the
  private bus socket lives under `/tmp` instead of TMPDIR, and a daemon that fails to start reports its
  stderr. dbus-daemon refuses socket paths over 99 bytes, and a trusted Calder slot's TMPDIR, nested once more
  by `nix develop`, made them 100 and 101 bytes long.
- `apps/server/src/persistence/OrchestrationEventStore.test.ts`: the replay page retention check
  yields before counting live pages. One synchronous fiber run usually spans a page boundary, so the frames
  that consumed the previous page could still hold it when the check ran.
- `apps/mobile/src/features/diffs/nativeReviewDiffHighlighter.test.ts`,
  `apps/mobile/src/features/review/shikiReviewHighlighter.test.ts` and `incrementalSnippet.test.ts`: the
  tests freeze `Date`. Shiki stops tokenizing a line once `Date.now()` passes its 500 ms
  `tokenizeTimeLimit` and returns the rest of the line as one token. The first line a cold JavaScript regex
  engine tokenizes takes about 0.5 s on srv-2 alone, so on a loaded worker one side of a comparison came
  back cut short.
- `apps/server/src/preview/ServerBrowserPage.test.ts`: the tests launch `T3CODE_BROWSER_TEST_CHROMIUM` when
  it is set, and the display viewport test reads the viewport before the page script replaces the globals
  instead of expecting `--window-size`. Full Chromium in headless mode keeps 87 px of the 800 px window
  for browser UI. Playwright's headless shell, which upstream runs, keeps none.
- `apps/server/integration/transferBudgetV2.integration.test.ts`: a shell stream also counts as done
  when it reports the measured run completed. The shell stream skips a thread shell equal to the one it
  last sent. On a loaded worker the turn's events reached it in two batches, the first already read the
  final shell, the second was skipped, and the test waited for the last sequence until it timed out.
- `scripts/notify-discord-release.test.ts`: the shells that run the release workflow's Discord steps get
  PATH. Their environment replaces the inherited one, and without PATH Node looks for `bash` only in `/bin`
  and `/usr/bin`.
- `packages/ssh/src/tunnel.test.ts`: the fake server logs its port as a string. `vp run --cache`, which
  the packages and scripts steps use, sets `FORCE_COLOR=1`, and Node colors a logged number, so the test
  read the port as `NaN`.
- `scripts/release-smoke.ts`: the smoke refreshes the copied lockfile, as the release workflow does, instead
  of deleting it and resolving from scratch. A fresh resolution takes any newer patch release once it is
  past pnpm 11's one-day `minimumReleaseAge`, and fails when the patched version is no longer resolved.
  On 2026-10-20 expo-modules-core 58.0.23 passed that age and the 58.0.22 patch went unused. This one is
  not NixOS-specific: upstream's smoke resolves the same way, and its last green run came 90 minutes
  before 58.0.23 turned a day old.

## Removing it

Each change is a portability fix upstream can take as is. Drop the matching line here once upstream has an
equivalent. The locale and `jujutsu` lines stay as long as Calder runs the checks.
